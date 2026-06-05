output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.this.name }
output "service_arn" { value = aws_ecs_service.this.id }
output "task_role_arn" { value = aws_iam_role.task.arn }
output "execution_role_arn" { value = aws_iam_role.execution.arn }
output "log_group_name" { value = aws_cloudwatch_log_group.this.name }
# Full ARN of the task definition revision Terraform just registered, including
# `:revision`. Deploys pass this to `update-service --task-definition` so the
# service actually adopts the new image (without it, `--force-new-deployment`
# redeploys whatever revision the service was last pinned to).
output "task_definition_arn" { value = aws_ecs_task_definition.this.arn }
