resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  comment         = "${var.name_prefix} tile API"
  is_ipv6_enabled = true
  web_acl_id      = var.web_acl_arn == "" ? null : var.web_acl_arn

  origin {
    domain_name = var.alb_dns_name
    origin_id   = "alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"

    # Full query-string cache key: url, rescale, colormap, bidx, etc. all matter.
    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = var.default_ttl_seconds
    max_ttl     = var.max_ttl_seconds
    compress    = true
  }

  # Never cache /health; CloudFront serves it through for load-balancer probes only.
  ordered_cache_behavior {
    path_pattern           = "/health"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    target_origin_id       = "alb"
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  aliases = var.aliases

  viewer_certificate {
    cloudfront_default_certificate = length(var.aliases) == 0 ? true : null
    acm_certificate_arn            = length(var.aliases) > 0 ? var.acm_certificate_arn : null
    ssl_support_method             = length(var.aliases) > 0 ? "sni-only" : null
    minimum_protocol_version       = length(var.aliases) > 0 ? "TLSv1.2_2021" : null
  }

  tags = { Name = "${var.name_prefix}-cdn-api" }
}
