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

  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

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
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:coreystevensdev/tellsight:*"
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
    services:
      redis:
        image: redis:7-alpine
        restart: always
        volumes:
          - redis_data:/data
        command: redis-server --save 60 1 --loglevel warning

      api:
        image: ${aws_ecr_repository.api.repository_url}:latest
        restart: always
        env_file: /opt/tellsight/.env
        environment:
          NODE_ENV: production
          PORT: "3001"
          REDIS_URL: redis://redis:6379
        ports:
          - "127.0.0.1:3001:3001"
        depends_on:
          - redis

      web:
        image: ${aws_ecr_repository.web.repository_url}:latest
        restart: always
        env_file: /opt/tellsight/.env
        environment:
          NODE_ENV: production
          PORT: "3000"
          API_INTERNAL_URL: http://api:3001
        ports:
          - "127.0.0.1:3000:3000"

      caddy:
        image: caddy:2-alpine
        restart: always
        ports:
          - "80:80"
          - "443:443"
        volumes:
          - /opt/tellsight/Caddyfile:/etc/caddy/Caddyfile
          - caddy_data:/data
          - caddy_config:/config
        depends_on:
          - api
          - web

    volumes:
      redis_data:
      caddy_data:
      caddy_config:
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
