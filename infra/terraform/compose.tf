# infra/compose/production.yml.tftpl is the only hand-edited copy of the compose
# file. ec2.tf's user_data interpolates this, and infra/compose/production.yml is
# its rendered output, kept because deployed-sha-drift.yml hashes the file on the
# box against production.yml.sha256 every six hours and a template has no hash.
#
# Before this, the heredoc in ec2.tf held its own copy with these three values
# interpolated and production.yml held them resolved, so the two were a template
# and its output pretending to be duplicates. DW-217 proposed collapsing them
# with file(), which would have deployed the resolved copy and silently
# hardcoded the account and region into the thing that provisions instances.
locals {
  compose_rendered = templatefile("${path.module}/../compose/production.yml.tftpl", {
    aws_region = var.aws_region
    api_image  = aws_ecr_repository.api.repository_url
    web_image  = aws_ecr_repository.web.repository_url
  })
}

# A precondition rather than a check block: check blocks emit warnings and a
# warning is what let the heredoc and its rendered copy drift apart unnoticed in
# the first place. This fails the plan.
#
# production.yml is generated, so it can go stale the moment the template moves,
# and the drift check six hours later would then compare the box against a hash
# of the wrong thing and report drift that is really staleness. Regenerate with:
#   terraform output -raw compose_rendered > ../compose/production.yml
#   shasum -a 256 ../compose/production.yml | cut -d' ' -f1 > ../compose/production.yml.sha256
resource "terraform_data" "compose_rendered_is_current" {
  input = sha256(local.compose_rendered)

  lifecycle {
    precondition {
      condition = trimsuffix(
        file("${path.module}/../compose/production.yml"), "\n"
      ) == trimsuffix(local.compose_rendered, "\n")
      error_message = "infra/compose/production.yml is stale against production.yml.tftpl. Regenerate it and its .sha256, see the comment above this resource."
    }
    precondition {
      condition = trimspace(
        file("${path.module}/../compose/production.yml.sha256")
      ) == sha256(file("${path.module}/../compose/production.yml"))
      error_message = "infra/compose/production.yml.sha256 does not match production.yml, so deployed-sha-drift.yml would compare the instance against the wrong hash."
    }
  }
}

# So the rendered copy can be regenerated without reading it out of state by hand.
output "compose_rendered" {
  value = local.compose_rendered
}
