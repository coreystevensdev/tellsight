# AWS ECS Deployment

Tellsight runs on AWS ECS Fargate. Two services:

- **API** (Express.js, port 3001) -- private subnet, reached by the web service via ECS Service Connect
- **Web** (Next.js, port 3000) -- private subnet, fronted by an Application Load Balancer

Supporting infrastructure: RDS PostgreSQL 18, ElastiCache Redis 7, ECR (two repositories), CloudWatch Logs, Secrets Manager, IAM roles with GitHub OIDC (no long-lived keys in CI).

## Prerequisites

- AWS CLI v2: `brew install awscli`
- Terraform >= 1.9: `brew install terraform`
- Docker: running locally

## First Deploy

### 1. Enable GitHub OIDC for AWS

If not already done, create the OIDC provider in IAM:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

### 2. Provision infrastructure

```bash
cd infra/terraform
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

Note the outputs:

```bash
terraform output
```

You will need `github_actions_role_arn`, `ecr_api_url`, `ecr_web_url`, `ecs_cluster_name`, `ecs_api_service_name`, `ecs_web_service_name`, and `alb_dns_name`.

### 3. Populate secrets

The Terraform creates a Secrets Manager secret with placeholder values. Replace them:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(terraform output -raw app_secret_arn)" \
  --secret-string '{
    "CLAUDE_API_KEY": "sk-ant-...",
    "CLAUDE_MODEL": "claude-sonnet-4-6",
    "STRIPE_SECRET_KEY": "sk_live_...",
    "STRIPE_WEBHOOK_SECRET": "whsec_...",
    "STRIPE_PRICE_ID": "price_...",
    "GOOGLE_CLIENT_ID": "....apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET": "...",
    "JWT_SECRET": "...at-least-32-characters..."
  }'
```

### 4. Set GitHub Actions secrets

In the GitHub repo Settings > Secrets > Actions, add:

| Secret | Value (from `terraform output`) |
|---|---|
| `AWS_ROLE_ARN` | `github_actions_role_arn` |
| `ECR_API_REPO` | `ecr_api_url` |
| `ECR_WEB_REPO` | `ecr_web_url` |
| `ECS_CLUSTER` | `ecs_cluster_name` |
| `ECS_API_SERVICE` | `ecs_api_service_name` |
| `ECS_WEB_SERVICE` | `ecs_web_service_name` |
| `ECS_API_TASK_FAMILY` | `tellsight-prod-api` |
| `ECS_WEB_TASK_FAMILY` | `tellsight-prod-web` |
| `PRODUCTION_URL` | `http://<alb_dns_name>` (or your custom domain) |

### 5. Push main to trigger deploy

Every push to `main` that passes CI triggers `deploy-aws.yml` automatically.

## Custom Domain (optional)

1. Request an ACM certificate in `us-east-1` for your domain (must be in us-east-1 for ALB).
2. Set `domain_name` and `acm_certificate_arn` in a `terraform.tfvars` file.
3. Run `terraform apply` to add the HTTPS listener and update the HTTP-to-HTTPS redirect.
4. Create a CNAME record in your DNS provider pointing `your-domain.com` to `alb_dns_name`.

## Estimated Cost

| Resource | Monthly (approx.) |
|---|---|
| ECS Fargate (2 tasks, 256 CPU / 512 MB each) | ~$14 |
| RDS PostgreSQL db.t3.micro | ~$15 (free tier eligible yr 1) |
| ElastiCache cache.t3.micro | ~$13 |
| ALB | ~$16 |
| NAT Gateway | ~$4 |
| **Total** | **~$62/mo** |

Use `FARGATE_SPOT` in `ecs.tf` to cut the Fargate line to ~$4/mo for non-production stages.

## Rollback

ECS deployment circuit breaker is enabled -- a task that fails its health check rolls back automatically. Manual rollback:

```bash
aws ecs update-service \
  --cluster tellsight-prod-cluster \
  --service tellsight-prod-api \
  --task-definition tellsight-prod-api:<PREVIOUS_REVISION>
```

## Destroy

```bash
terraform destroy
```

Note: `deletion_protection = true` on RDS prevents accidental deletion. Remove it first if destroying permanently:

```bash
terraform apply -target=aws_db_instance.main -var="deletion_protection=false"
terraform destroy
```
