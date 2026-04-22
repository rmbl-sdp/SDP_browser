# Non-secret staging inputs. Secrets go via GitHub Actions OIDC, never here.

aws_region  = "us-east-2"
name_prefix = "sdp-browser-staging"
github_repo = "rmbl-sdp/SDP_browser"

# Leave domain fields empty until RMBL DNS + ACM cert are set up; the stack
# will use the default *.cloudfront.net hostnames.
domain_name         = "sdpbrowser.org"
api_domain_name     = "api.sdpbrowser.org"
acm_certificate_arn = "arn:aws:acm:us-east-1:254459631110:certificate/861f60a7-5344-4157-86d1-ed66a19e0fdc"

# Staging is sized small; prod is larger. Override per tfvars as needed.
task_cpu      = 1024
task_memory   = 2048
desired_count = 1
max_count     = 2
