# Production compose file

This is a copy of what `/opt/tellsight/docker-compose.yml` contains on the
instance, rendered from the `user_data` heredoc in `../terraform/ec2.tf`.

It is a copy rather than the source because `user_data` carries Terraform
interpolations (the ECR repository URLs and the region), so the heredoc text and
the deployed text are not the same bytes. The heredoc stays authoritative for a
newly built instance.

The reason a copy exists at all is that `aws_instance.main` sets
`lifecycle { ignore_changes = [user_data, ...] }`, and `user_data` only executes
on first boot regardless. Editing the heredoc therefore changes nothing about a
running box: `terraform apply` reports no diff and nothing reads the deployed
file back. A compose change needs both an edit here and an edit on the instance,
and before this file existed there was no way to notice when only one happened.

`production.yml.sha256` is what the scheduled drift check compares the
instance's file against.

## Changing the production compose file

1. Edit the heredoc in `../terraform/ec2.tf`.
2. Render it and write it here:

   ```
   cd infra/terraform
   echo 'local.user_data' | terraform console \
     | awk "/docker-compose.yml << 'COMPOSE'/{f=1;next} /^COMPOSE$/{f=0} f" \
     > ../compose/production.yml
   shasum -a 256 ../compose/production.yml | awk '{print $1}' \
     > ../compose/production.yml.sha256
   ```

3. Copy it to the instance and recreate whichever services the change affects.
   Only api and web are recreated by a normal deploy; redis and caddy are not.
