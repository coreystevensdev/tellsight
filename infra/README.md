# AWS Deployment (Free Tier)

Tellsight runs on a single EC2 t2.micro with Docker Compose. Redis runs as a container on the same instance. RDS db.t3.micro handles PostgreSQL. Both are free-tier eligible for 12 months on a new AWS account.

**Cost: $0/month for the first 12 months.** After free tier expires: ~$22/month (t2.micro ~$8.50 + db.t3.micro ~$13).

## Architecture

```
Internet
    |
    v (80/443)
nginx (EC2 t2.micro, 1 vCPU, 1 GB RAM + 1 GB swap)
    |-- /api/*  --> Express API (Docker, 127.0.0.1:3001)
    |-- /*      --> Next.js web (Docker, 127.0.0.1:3000)

Docker Compose services:
    redis    (redis:7-alpine, internal only)
    api      (ECR image, port 3001)
    web      (ECR image, port 3000)

EC2 --> RDS db.t3.micro (PostgreSQL 16, private security group)
```

No ALB, no NAT Gateway, no ElastiCache. This is a deliberate trade-off: zero HA for zero infra cost.

## Prerequisites

- AWS CLI v2: `brew install awscli && aws configure`
- Terraform >= 1.9: `brew install tfenv && tfenv install 1.9.8 && tfenv use 1.9.8`
- Docker: running locally

## Step 1: S3 backend for Terraform state

Create once per AWS account:

```bash
aws s3api create-bucket --bucket coreystevensdev-tfstate --region us-east-1
aws s3api put-bucket-versioning \
  --bucket coreystevensdev-tfstate \
  --versioning-configuration Status=Enabled
```

## Step 2: GitHub Actions OIDC provider

Create once per AWS account:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

## Step 3: Apply Terraform

```bash
cd infra/terraform
terraform init
terraform plan -var db_password=<strong-password>
terraform apply -var db_password=<strong-password>
```

Save all outputs -- you need them in Step 5:

```bash
terraform output
```

## Step 4: Point DNS to the Elastic IP

In your DNS provider, create an A record:

```
tellsight.coreystevens.dev  A  <instance_public_ip from terraform output>
```

Wait for propagation (typically 1-5 minutes on Cloudflare).

## Step 5: Set GitHub Actions secrets

In the repo Settings > Secrets > Actions, add:

| Secret | Value |
|---|---|
| `AWS_ROLE_ARN` | `github_actions_role_arn` from `terraform output` |
| `EC2_INSTANCE_ID` | `instance_id` from `terraform output` |
| `ECR_API_REPO` | `ecr_api_url` from `terraform output` |
| `ECR_WEB_REPO` | `ecr_web_url` from `terraform output` |
| `DATABASE_URL` | `postgresql://app_admin:<db_password>@<rds_endpoint>:5432/analytics` |
| `CLAUDE_API_KEY` | `sk-ant-...` |
| `CLAUDE_MODEL` | `claude-sonnet-4-6` |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `STRIPE_PRICE_ID` | `price_...` |
| `GOOGLE_CLIENT_ID` | `....apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | `...` |
| `JWT_SECRET` | 32+ character random string |
| `PRODUCTION_URL` | `https://tellsight.coreystevens.dev` |

## Step 6: First deploy

Push to main or trigger the deploy workflow manually from the Actions tab. The workflow:

1. Builds and pushes API and web Docker images to ECR
2. Uses SSM SendCommand to write `/opt/tellsight/.env` on the EC2 instance (no SSH key needed)
3. Pulls new images and runs `docker compose up -d`
4. Smoke-tests `/api/health/ready` for up to 3 minutes

## Step 7: Enable HTTPS

After DNS propagates and the first deploy succeeds:

```bash
# Open a session on the instance via AWS Systems Manager (no SSH key needed)
aws ssm start-session --target <instance_id from terraform output>

# On the instance:
sudo certbot --nginx -d tellsight.coreystevens.dev
```

Certbot auto-renews every 90 days via a systemd timer that ships with `python3-certbot-nginx`.

## Subsequent deploys

Every push to `main` that passes CI triggers the deploy workflow automatically.

## Rollback

To roll back to a previous image:

```bash
# Open a session on the instance
aws ssm start-session --target <instance_id>

# On the instance:
cd /opt/tellsight

# Edit docker-compose.yml to pin the previous image tag, then:
docker compose pull
docker compose up -d --remove-orphans
```

Previous image tags are visible in the ECR console or via:

```bash
aws ecr list-images --repository-name tellsight-api
```

## Destroy

```bash
cd infra/terraform
terraform destroy -var db_password=<password>
```

## Free Tier Reference

| Resource | Free Tier |
|---|---|
| EC2 t2.micro | 750 hrs/month for 12 months (one always-on instance) |
| RDS db.t3.micro | 750 hrs/month + 20 GB storage for 12 months |
| ECR | 500 MB/repo/month |
| EBS gp3 | 30 GB/month total |
| Elastic IP | Free when associated with a running instance |
| Data transfer | 1 GB/month outbound free |

Elastic IP charges $0.005/hr when the instance is stopped. RDS storage beyond 20 GB is billed at $0.115/GB/month after free tier.
