# Non-secret prod inputs. Secrets go via GitHub Actions OIDC, never here.

aws_region  = "us-east-2"
name_prefix = "sdp-browser-prod"
github_repo = "rmbl-sdp/SDP_browser"

# Fill in once RMBL DNS + ACM are provisioned; leaving empty uses the
# default *.cloudfront.net hostnames.
domain_name         = ""
api_domain_name     = ""
acm_certificate_arn = ""

# Prod is sized for workshop load; start 2 tasks and autoscale to 6.
task_cpu      = 2048
task_memory   = 4096
desired_count = 2
max_count     = 6
