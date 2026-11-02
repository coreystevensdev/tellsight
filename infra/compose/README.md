# Production compose file

`production.yml.tftpl` is the only hand-edited copy. `../terraform/compose.tf`
renders it into `user_data`, and `production.yml` is that render with the three
Terraform values resolved.

The render exists because the scheduled drift check hashes
`/opt/tellsight/docker-compose.yml` on the instance against
`production.yml.sha256` every six hours, and a template has no hash. Two
preconditions on `terraform_data.compose_rendered_is_current` fail the plan if
either generated file goes stale, so the three copies can no longer drift
quietly.

Until DW-217 the heredoc in `ec2.tf` held its own copy of all 85 lines with
`${var.aws_region}` and the two `aws_ecr_repository` URLs interpolated, and
`production.yml` held them resolved. They looked like duplicates and were really
a template and its output, which is why DW-217's own suggestion of collapsing
them with `file()` would have been wrong: it would have deployed the resolved
copy and hardcoded the account and region into the thing that provisions
instances.

Editing the compose file still changes nothing about a running box.
`aws_instance.main` sets `lifecycle { ignore_changes = [user_data, ami] }` and
`user_data` only executes on first boot, so `terraform apply` reports no diff.
The instance needs the file copied to it separately. That part is unchanged and
is the reason the drift check exists.

## Changing the production compose file

1. Edit `production.yml.tftpl`.
2. Regenerate the render and its hash:

   ```
   cd infra/terraform
   terraform output -raw compose_rendered > ../compose/production.yml
   shasum -a 256 ../compose/production.yml | awk '{print $1}' \
     > ../compose/production.yml.sha256
   ```

   `terraform output -raw` keeps the template's trailing newline, so do not add
   one. `terraform plan` fails until both files match, and the error names which.

3. Copy it to the instance and recreate whichever services the change affects.
   Only api and web are recreated by a normal deploy; redis and caddy are not.
