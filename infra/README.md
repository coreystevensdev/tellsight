# AWS Deployment (Free Tier)

Tellsight runs on a single EC2 t3.micro with Docker Compose (redis, api, web). RDS db.t3.micro handles PostgreSQL. Caddy on the host handles TLS automatically, no domain purchase needed, it gets a real Let's Encrypt cert against the instance's own public DNS name.

**Cost: $0/month for the first 12 months on a new AWS account.** After free tier expires: ~$22/month (t3.micro ~$8.50 + db.t3.micro ~$13).

Prometheus and Grafana are intentionally **not** deployed here, 1 GB RAM (t3.micro) doesn't reliably fit them alongside redis/api/web. Local dev's `docker-compose.yml` still runs the full observability stack; this is a demo-cost trade-off specific to this deploy target, not a claim that observability tooling doesn't exist in the codebase. If you want them on the live instance too, resize to `t3.small` (~$15/month, not free-tier eligible) and re-add the two services, see git history on `infra/terraform/ec2.tf` for the exact block.

## Architecture

```
Internet
    |
    v (80/443, Let's Encrypt via Caddy)
Caddy (EC2 t3.micro, 1 vCPU/1 GB RAM + 1 GB swap)
    |-- /api/*  --> Express API (Docker, 127.0.0.1:3001)
    |-- /*      --> Next.js web (Docker, 127.0.0.1:3000)

Docker Compose services (all internal, none published beyond 127.0.0.1):
    redis  (redis:7-alpine)
    api    (ECR image, 127.0.0.1:3001)
    web    (ECR image, 127.0.0.1:3000)

EC2 --> RDS db.t3.micro (PostgreSQL 18, private security group)
```

No ALB, no NAT Gateway, no ElastiCache, no Prometheus/Grafana on this instance. This is a deliberate trade-off: zero HA and no live observability, for zero infra cost.

## Prerequisites

- AWS CLI v2: `brew install awscli && aws configure`
- Terraform >= 1.9: `brew install tfenv && tfenv install 1.9.8 && tfenv use 1.9.8`
- Docker: running locally
- `psql` (for the one-time RDS role setup in Step 4)

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

Before applying, confirm the RDS Postgres major version is actually available in your region (`infra/terraform/rds.tf` targets 17, bump to 18 if it's listed):

```bash
aws rds describe-db-engine-versions --engine postgres --query "DBEngineVersions[].EngineVersion"
```

```bash
cd infra/terraform
terraform init
terraform plan -var db_password=<strong-password>
terraform apply -var db_password=<strong-password>
```

Save all outputs, you need them in Steps 4 and 6:

```bash
terraform output
```

## Step 4: One-time RDS role setup

RDS only creates the master user (`app_admin`, RLS-bypassing). The app also needs a restricted `app_user` role for RLS to actually be enforced, mirroring `docker/init.sql` for local dev. This must run **before the first deploy**, migrations create tables that need `app_user`'s default privileges applied at creation time.

```bash
# Open a port-forward to the private RDS endpoint (no public access, no SSH key)
aws ssm start-session --target <instance_id from terraform output> \
  --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters '{"host":["<rds_endpoint from terraform output>"],"portNumber":["5432"],"localPortNumber":["5432"]}'

# In another terminal, edit infra/rds-init.sql's placeholder password first, then:
psql "postgresql://app_admin:<db_password>@localhost:5432/analytics" -f infra/rds-init.sql
```

## Step 5: Set GitHub Actions secrets

In the repo Settings > Secrets > Actions, add:

| Secret | Value |
|---|---|
| `AWS_ROLE_ARN` | `github_actions_role_arn` from `terraform output` |
| `EC2_INSTANCE_ID` | `instance_id` from `terraform output` |
| `ECR_API_REPO` | `ecr_api_url` from `terraform output` |
| `ECR_WEB_REPO` | `ecr_web_url` from `terraform output` |
| `PRODUCTION_DOMAIN` | `eip_public_dns` from `terraform output` (no domain purchase needed) |
| `PRODUCTION_URL` | `https://<eip_public_dns>` |
| `DATABASE_URL` | `postgresql://app_user:<app_user password from Step 4>@<rds_endpoint>:5432/analytics` |
| `DATABASE_ADMIN_URL` | `postgresql://app_admin:<db_password>@<rds_endpoint>:5432/analytics` |
| `CLAUDE_API_KEY` | `sk-ant-...` |
| `CLAUDE_MODEL` | `claude-sonnet-4-5-20250929` |
| `STRIPE_SECRET_KEY` | `sk_live_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` |
| `STRIPE_PRICE_ID` | `price_...` |
| `GOOGLE_CLIENT_ID` | `....apps.googleusercontent.com` |
| `GOOGLE_CLIENT_SECRET` | `...` |
| `JWT_SECRET` | 32+ character random string (`openssl rand -hex 32`) |
| `EMAIL_FROM_ADDRESS` | a verified Resend sender, not a placeholder domain (rejected in production) |
| `EMAIL_FROM_NAME` | your real sender name, not the "Kiln Insights" placeholder (rejected in production) |
| `EMAIL_MAILING_ADDRESS` | your real physical mailing address (CAN-SPAM) |
| `RESEND_API_KEY` | `re_...` |
| `RESEND_WEBHOOK_SECRET` | Svix-shared secret from the Resend webhook config |
| `METRICS_TOKEN` | `openssl rand -hex 24` |
| `QUICKBOOKS_CLIENT_ID` | optional, Intuit developer app's **Production** keys (not Development/sandbox) |
| `QUICKBOOKS_CLIENT_SECRET` | optional, same Intuit app |
| `QUICKBOOKS_REDIRECT_URI` | optional, `https://<eip_public_dns>/integrations/quickbooks/callback`, must also be registered as an authorized redirect URI in the Intuit app |
| `QUICKBOOKS_ENVIRONMENT` | optional, `production` once you have live Intuit keys, defaults to `sandbox` if unset |
| `ENCRYPTION_KEY` | optional, `openssl rand -hex 32`, encrypts QuickBooks OAuth tokens at rest |

`DATABASE_URL` and `DATABASE_ADMIN_URL` must point at different roles (`app_user` vs `app_admin`), not the same connection string, otherwise every query bypasses RLS.

QuickBooks is fully optional, the app boots and runs fine with none of the five QuickBooks/`ENCRYPTION_KEY` secrets set, `isQbConfigured()` just gates the connector off. Set all five together or none, a partial set (e.g. client ID without `ENCRYPTION_KEY`) also leaves the connector disabled.

## Step 6: First deploy

Push to main, or trigger the deploy workflow manually from the Actions tab. The workflow:

1. Builds and pushes API and web Docker images to ECR
2. Uses SSM SendCommand to write `/opt/tellsight/.env` and the real `/etc/caddy/Caddyfile` on the EC2 instance (no SSH key needed), then reloads Caddy
3. Pulls new images and runs `docker compose up -d`
4. Smoke-tests `/api/health/ready` for up to 3 minutes

HTTPS is live immediately after this, Caddy requests the Let's Encrypt cert automatically on first reload once the Caddyfile has the real domain.

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

## Observability

Not deployed on this instance, see the note at the top of this doc. For log tailing, use `docker compose logs` over an SSM session, covered in `docs/deploy-runbook.md` section 3.

## Destroy

```bash
cd infra/terraform
terraform destroy -var db_password=<password>
```

## Free Tier Reference

| Resource | Free Tier |
|---|---|
| EC2 t3.micro | 750 hrs/month for 12 months (one always-on instance) |
| RDS db.t3.micro | 750 hrs/month + 20 GB storage for 12 months |
| ECR | 500 MB/repo/month |
| EBS gp3 | 30 GB/month total |
| Elastic IP | Free when associated with a running instance |
| Data transfer | 1 GB/month outbound free |

Elastic IP charges $0.005/hr when the instance is stopped. RDS storage beyond 20 GB is billed at $0.115/GB/month after free tier. After the first 12 months, both EC2 and RDS switch to standard billing (~$22/month combined).
