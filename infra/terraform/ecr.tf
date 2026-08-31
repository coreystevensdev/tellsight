# aws_ecr_repository.api / .web are declared in ec2.tf (referenced directly by
# the compose template in local.user_data). This file only adds lifecycle
# policies on top of those, expire untagged images after 14 days; keep the 10
# most recent tagged images.
resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Remove untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      # One rule per prefix. tagPrefixList is AND, not OR: the previous single
      # rule listed ["v", "sha-"] and so only matched an image carrying both a
      # v* and a sha-* tag. Ours only ever carry sha-*, so it matched nothing
      # and expired nothing for 26 days, while both repos grew to 64 images and
      # 26GB. start-lifecycle-policy-preview reported wouldExpire: 0.
      #
      # 15, not 10: deploy-history keeps 10 entries and the rollback pulls from
      # ECR, so every one of them has to still be here. At 10 the oldest entry
      # sits exactly on the expiry boundary.
      {
        rulePriority = 2
        description  = "Keep 15 most recent sha- tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["sha-"]
          countType     = "imageCountMoreThan"
          countNumber   = 15
        }
        action = { type = "expire" }
      },
      {
        rulePriority = 3
        description  = "Keep 15 most recent v tagged images"
        selection = {
          tagStatus     = "tagged"
          tagPrefixList = ["v"]
          countType     = "imageCountMoreThan"
          countNumber   = 15
        }
        action = { type = "expire" }
      }
    ]
  })
}

resource "aws_ecr_lifecycle_policy" "web" {
  repository = aws_ecr_repository.web.name

  policy = aws_ecr_lifecycle_policy.api.policy
}
