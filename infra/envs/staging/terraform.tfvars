# Non-secret staging inputs. Secrets go via GitHub Actions OIDC, never here.

aws_region  = "us-east-2"
name_prefix = "sdp-browser-staging"
github_repo = "rmbl-sdp/SDP_browser"

# Leave domain fields empty until RMBL DNS + ACM cert are set up; the stack
# will use the default *.cloudfront.net hostnames.
domain_name         = ""
api_domain_name     = ""
acm_certificate_arn = ""

# Staging is sized small; prod is larger. Override per tfvars as needed.
task_cpu      = 1024
task_memory   = 2048
desired_count = 1
max_count     = 2
