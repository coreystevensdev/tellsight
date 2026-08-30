# The AWS free plan caps automated backup retention at 1 day
# (FreeTierRestrictionError above that, verified 2026-08-30), so PITR alone
# gives a one-day recovery window. AWS Backup snapshots are separate from that
# cap and are what gives the database a real history.
#
# Deliberately not a GitHub Actions cron: scheduled workflows can be delayed or
# dropped under load, which is a bad property for the thing that protects the
# database. This runs in AWS on its own schedule.

resource "aws_backup_vault" "main" {
  name = "${local.name}-vault"
  tags = { Name = "${local.name}-vault" }
}

resource "aws_iam_role" "backup" {
  name = "${local.name}-backup-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${local.name}-backup-role" }
}

# AWS-managed policies rather than hand-rolled: the backup service's required
# permissions change as it gains resource types, and pinning our own copy means
# silently broken jobs later.
resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

resource "aws_backup_plan" "main" {
  name = "${local.name}-daily"

  rule {
    rule_name         = "daily-retain-30"
    target_vault_name = aws_backup_vault.main.name

    # 09:15 UTC, just after the instance's own 08:30-09:00 backup window, so
    # both land in the same quiet stretch. This is single-AZ, and a snapshot
    # briefly suspends I/O.
    schedule = "cron(15 9 * * ? *)"

    # Give the job room to start if AWS is busy, then let it run.
    start_window      = 60
    completion_window = 180

    lifecycle {
      delete_after = 30
    }
  }
}

resource "aws_backup_selection" "rds" {
  name         = "${local.name}-rds"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.main.id

  resources = [aws_db_instance.main.arn]
}
