# Non-secret staging inputs. Secrets go via GitHub Actions OIDC, never here.

aws_region  = "us-east-2"
name_prefix = "sdp-browser-staging"
github_repo = "rmbl-sdp/SDP_browser"

# Leave domain fields empty until RMBL DNS + ACM cert are set up; the stack
# will use the default *.cloudfront.net hostnames.
domain_name         = "sdpbrowser.org"
api_domain_name     = "api.sdpbrowser.org"
acm_certificate_arn = "arn:aws:acm:us-east-1:254459631110:certificate/861f60a7-5344-4157-86d1-ed66a19e0fdc"

# Sized for low idle cost + spike absorption. Horizontal scaling per SPEC
# design intent: 1 vCPU/2 GB tasks, autoscale floor 2 (redundancy + absorb
# first burst), ceiling 10 (headroom for unscheduled demo/workshop spikes;
# only billed during the spike), scale out earlier on CPU (40%). Tuned after
# the 2026-06-12 demo where the burst peaked + receded inside the 9-min
# scale-out window — earlier trigger + bigger ceiling shorten the window of
# pain. Health-check grace cut to 60s (services/titiler is healthy in <30s
# in practice) to reduce the lag between "task launching" and "task taking
# traffic" by ~60s per added task.
task_cpu             = 1024
task_memory          = 2048
desired_count        = 2
max_count            = 10
cpu_autoscale_target = 40

# Co-located users share one NAT IP; WAF counts every request (incl. CloudFront
# cache hits) before cache, so a workshop room can trip a tight per-IP limit.
# Raised from the 10000 default to give a shared IP headroom while keeping the
# AWS managed bot/bad-input rules intact.
waf_rate_limit_per_5min = 25000
