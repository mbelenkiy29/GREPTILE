output "load_balancer_dns_name" {
  description = "Point the three host names (CNAME or alias) at this."
  value       = aws_lb.main.dns_name
}
output "cluster_name" {
  description = "ECS cluster running the web and backend services."
  value       = aws_ecs_cluster.main.name
}
output "efs_file_system_id" {
  description = "EFS file system holding the Convex data directory (backed up by AWS Backup)."
  value       = aws_efs_file_system.data.id
}
