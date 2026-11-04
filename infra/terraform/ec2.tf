# Two ECR repos: free tier 500 MB/repo/month.
resource "aws_ecr_repository" "api" {
  name                 = "${local.name}-api"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  tags = { Name = "${local.name}-api" }
}

resource "aws_ecr_repository" "web" {
  name                 = "${local.name}-web"
  image_tag_mutability = "MUTABLE"
  image_scanning_configuration { scan_on_push = true }
  tags = { Name = "${local.name}-web" }
}

# ------------------------------------------------------------------
# Security groups
# ------------------------------------------------------------------

resource "aws_security_group" "ec2" {
  name        = "${local.name}-ec2-sg"
  description = "HTTP, HTTPS, SSH inbound; all outbound"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # No SSH ingress. Deploys reach this instance through SSM SendCommand over
  # outbound 443, so port 22 was open to the whole internet for nothing: sshd
  # was listening with zero authorized keys, which is an unauthenticatable
  # daemon and a standing invitation to every scanner on the internet.
  #
  # The fallback if the SSM agent ever stops answering is EC2 Serial Console, or
  # re-adding this rule, which is a one line change and a thirty second apply.

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-ec2-sg" }
}

# ------------------------------------------------------------------
# IAM: EC2 instance role (ECR pull + SSM for key-free remote exec)
# ------------------------------------------------------------------

resource "aws_iam_role" "ec2" {
  name = "${local.name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# SSM agent lets GitHub Actions send deploy commands without an SSH key.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ec2.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Lets the instance mint an OIDC token asserting its own role ARN, which
# Anthropic exchanges for a short-lived API token instead of a static key.
# GetWebIdentityToken takes no resource ARN, so "*" is the only valid scope;
# the real constraint is the federation rule's subject_prefix at Anthropic,
# which must pin this role exactly. Requires the account-level outbound
# federation flag, enabled 2026-09-19.
resource "aws_iam_role_policy" "ec2_web_identity" {
  name = "${local.name}-ec2-web-identity"
  role = aws_iam_role.ec2.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "MintWebIdentityToken"
      Effect   = "Allow"
      Action   = "sts:GetWebIdentityToken"
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  name = "${local.name}-ec2-profile"
  role = aws_iam_role.ec2.name
}

# ------------------------------------------------------------------
# IAM: GitHub Actions OIDC role (push images + SSM deploy)
# ------------------------------------------------------------------

resource "aws_iam_role" "github_actions" {
  name = "${local.name}-github-actions"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      # Narrowed from StringLike on repo:coreystevensdev/tellsight:*, which
      # matched every subject GitHub can mint for this repo. A pull_request
      # event presents repo:owner/repo:pull_request rather than a ref, so the
      # wildcard let PR-triggered code assume a role carrying ssm:SendCommand
      # on every instance. Nothing did, but alarm-pattern-drift.yml nearly
      # became the first, and a guard inside one workflow is weaker than a
      # condition on the role.
      #
      # main only, not refs/heads/*: no AWS workflow triggers on a branch push
      # today, and a branch that added one should not reach this role. The
      # three consumers all present ref:refs/heads/main, deploy-aws via
      # workflow_run on main, deployed-sha-drift via schedule, migrate via
      # dispatch from the default branch. Dispatching migrate.yml from a
      # feature branch stops working, which for a migration tool is the point.
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:coreystevensdev/tellsight:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_actions" {
  name = "${local.name}-github-actions-policy"
  role = aws_iam_role.github_actions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ECRAuth"
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Sid    = "ECRPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload",
          "ecr:PutImage",
        ]
        Resource = [
          aws_ecr_repository.api.arn,
          aws_ecr_repository.web.arn,
        ]
      },
      {
        Sid    = "SSMDeploy"
        Effect = "Allow"
        Action = [
          "ssm:SendCommand",
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations",
        ]
        Resource = "*"
      },
    ]
  })
}

# ------------------------------------------------------------------
# IAM: alarm-drift role (one read action, main only)
# ------------------------------------------------------------------

# Separate from github_actions deliberately. alarm-pattern-drift.yml needs
# exactly one read action, and putting it on the deploy role would have meant
# that workflow also held ssm:SendCommand on every instance, which is remote
# execution on production. The role is the grant, not the statement appended
# to it.
#
# Trust is scoped to main, unlike the deploy role's repo-wide wildcard: a
# scheduled or dispatched run from the default branch presents
# repo:coreystevensdev/tellsight:ref:refs/heads/main, and nothing else has any
# reason to assume this. The deploy role's wildcard is pre-existing and worth
# narrowing on its own; this role does not inherit the problem.
resource "aws_iam_role" "alarm_drift" {
  name = "${local.name}-alarm-drift"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:oidc-provider/token.actions.githubusercontent.com"
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:coreystevensdev/tellsight:ref:refs/heads/main"
        }
      }
    }]
  })

  tags = { Name = "${local.name}-alarm-drift" }
}

# Scoped to the one log group rather than "*", since DescribeMetricFilters takes
# a log-group resource. If the check ever fails with AccessDenied after an apply,
# this scoping is the first thing to suspect.
resource "aws_iam_role_policy" "alarm_drift" {
  name = "${local.name}-alarm-drift-policy"
  role = aws_iam_role.alarm_drift.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ReadMetricFilters"
      Effect   = "Allow"
      Action   = "logs:DescribeMetricFilters"
      Resource = "${aws_cloudwatch_log_group.containers.arn}:*"
    }]
  })
}

# ------------------------------------------------------------------
# EC2 instance
# ------------------------------------------------------------------

locals {
  # Caddy placeholder config + Docker Compose template written during first boot.
  # Secrets are NOT in user_data -- they are written by the deploy workflow
  # via SSM SendCommand on each deploy.
  user_data = <<-SHELL
    #!/bin/bash
    set -e

    # 1 GB swap prevents OOM on t3.micro (1 GB RAM total, shared with
    # redis + api + web + Caddy on the host)
    fallocate -l 1G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
    echo '/swapfile none swap sw 0 0' >> /etc/fstab

    # Docker
    yum install -y docker
    systemctl enable docker
    systemctl start docker
    usermod -aG docker ec2-user

    # Docker Compose v2 CLI plugin
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -SL "https://github.com/docker/compose/releases/download/v2.29.1/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

    # Caddy runs as a Docker container (official image), not a native package --
    # the @caddy/caddy COPR repo has no amazonlinux-2023-x86_64 build, which
    # made this a hard boot failure the first time this was tried (dnf copr
    # enable errored, set -e aborted the whole script before anything below
    # this point ever ran). Docker sidesteps distro-repo compatibility
    # entirely and matches this deploy's all-Docker approach anyway.

    # App directory
    mkdir -p /opt/tellsight

    # `docker compose up caddy` still parses and validates the whole compose
    # file, including the env_file: reference on api/web -- it refuses to
    # start anything at all if that path doesn't exist yet, even though only
    # caddy is being started here. Real secrets get written over this by the
    # deploy workflow before api/web ever actually start.
    touch /opt/tellsight/.env

    # Real domain isn't known until the Elastic IP exists (see outputs.tf
    # eip_public_dns), so this placeholder gets overwritten by deploy-aws.yml
    # via SSM on first deploy, same pattern already used for .env secrets.
    cat > /opt/tellsight/Caddyfile << 'CADDY'
    :80 {
        respond "tellsight: awaiting first deploy"
    }
    CADDY

    # Docker Compose config -- secrets loaded from /opt/tellsight/.env at container start.
    # caddy is the only service published beyond 127.0.0.1; it reaches api/web
    # by Docker Compose's internal service-name DNS, not the host loopback.
    cat > /opt/tellsight/docker-compose.yml << 'COMPOSE'
    ${trimsuffix(local.compose_rendered, "\n")}
    COMPOSE

    # No Prometheus/Grafana on this instance -- 1 GB RAM (free tier) doesn't
    # reliably fit them alongside redis/api/web. Local dev's docker-compose.yml
    # still runs the full observability stack; this is a demo-cost trade-off,
    # not a claim that observability doesn't exist in the codebase.

    # api and web have no image to pull yet (no deploy has run), so only bring
    # up caddy here -- it'll serve the placeholder response above until the
    # first real deploy runs `docker compose up -d --remove-orphans`.
    cd /opt/tellsight && docker compose up -d caddy
  SHELL
}

resource "aws_instance" "main" {
  ami = data.aws_ami.al2023.id
  # Free tier: 750 hrs/month for the first 12 months on a new AWS account.
  # 1 GB RAM fits redis + api + web + Caddy with the swap below; Prometheus
  # and Grafana were dropped from this instance specifically to fit this size.
  instance_type          = "t3.micro"
  iam_instance_profile   = aws_iam_instance_profile.ec2.name
  vpc_security_group_ids = [aws_security_group.ec2.id]
  subnet_id              = tolist(data.aws_subnets.default.ids)[0]

  user_data = base64encode(local.user_data)

  # The API runs on a bridge network, so IMDS takes an extra hop that a limit
  # of 1 refuses. The instance has answered at 2 since launch by luck, not this.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }

  root_block_device {
    # Free tier: 30 GB EBS storage total.
    volume_size           = 20
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = { Name = "${local.name}-server" }

  # Do not re-run user_data on AMI updates -- it's idempotent only on first boot.
  lifecycle {
    ignore_changes = [user_data, ami]
  }
}

# Static IP: free when associated with a running instance.
resource "aws_eip" "main" {
  instance = aws_instance.main.id
  domain   = "vpc"
  tags     = { Name = "${local.name}-eip" }
}
