output "ecr_repository_url" {
  value = module.ecr_titiler.repository_url
}

output "ecs_cluster_name" {
  value = module.ecs_titiler.cluster_name
}

output "ecs_service_name" {
  value = module.ecs_titiler.service_name
}

output "ecs_task_definition_arn" {
  value = module.ecs_titiler.task_definition_arn
}

output "api_distribution_id" {
  value = module.cloudfront_api.distribution_id
}

output "api_distribution_domain" {
  value = module.cloudfront_api.distribution_domain_name
}

output "site_bucket_name" {
  value = module.cloudfront_site.bucket_name
}

output "site_distribution_id" {
  value = module.cloudfront_site.distribution_id
}

output "site_distribution_domain" {
  value = module.cloudfront_site.distribution_domain_name
}

output "github_deploy_role_arn" {
  value = module.github_oidc.deploy_role_arn
}
