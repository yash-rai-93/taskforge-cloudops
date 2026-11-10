# Optional account-level provider. Import it before enabling this module if it
# already exists in the target account.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.enable_ssm_cd ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

resource "aws_iam_role" "github_deploy" {
  count = var.enable_ssm_cd ? 1 : 0
  name  = "${var.name}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = aws_iam_openid_connect_provider.github[0].arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # GitHub's immutable default subject for this repository and environment.
          "token.actions.githubusercontent.com:sub" = "repo:yash-rai-93@132800857/taskforge-cloudops@1451419157:environment:production"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "github_deploy" {
  count = var.enable_ssm_cd ? 1 : 0
  name  = "taskforge-ssh-session"
  role  = aws_iam_role.github_deploy[0].name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ssm:StartSession"
        Resource = aws_instance.host.arn
        Condition = {
          # The instance authorization request can omit the document check key.
          BoolIfExists = { "ssm:SessionDocumentAccessCheck" = "true" }
        }
      },
      {
        Effect   = "Allow"
        Action   = "ssm:StartSession"
        Resource = "arn:aws:ssm:${var.aws_region}::document/AWS-StartSSHSession"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:TerminateSession", "ssmmessages:OpenDataChannel"]
        Resource = "arn:aws:ssm:${var.aws_region}:${var.aws_account_id}:session/$${aws:userid}-*"
      }
    ]
  })
}

output "github_deploy_role_arn" {
  description = "Role ARN for the GitHub production environment."
  value       = try(aws_iam_role.github_deploy[0].arn, null)
}

resource "aws_vpc_security_group_egress_rule" "smtp" {
  count             = var.enable_smtp_egress ? 1 : 0
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 465
  to_port           = 465
  description       = "Implicit TLS SMTP submission"
}
