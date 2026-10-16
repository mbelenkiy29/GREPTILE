variable "region" {
  description = "AWS region."
  type        = string
}
variable "name" {
  description = "Name prefix for every resource."
  type        = string
  default     = "openreview"
}
variable "vpc_cidr" {
  description = "CIDR block of the VPC."
  type        = string
  default     = "10.40.0.0/16"
}
variable "web_image" {
  description = "OpenReview web image (built from this repository's Dockerfile), pinned by digest."
  type        = string
}
variable "backend_image" {
  description = "Self-hosted Convex backend image, pinned by digest."
  type        = string
  default     = "ghcr.io/get-convex/convex-backend@sha256:d715e9ec088784407ca4ba2d3db592702cd328d02c76cdca3852c0018f2a76b4"
}
variable "certificate_arn" {
  description = "ACM certificate covering the three host names below."
  type        = string
}
variable "web_host" {
  description = "Public host name of the web app, for example review.example.com."
  type        = string
}
variable "backend_host" {
  description = "Public host name of the Convex functions endpoint (port 3210)."
  type        = string
}
variable "site_host" {
  description = "Public host name of the Convex HTTP actions endpoint (port 3211, webhooks)."
  type        = string
}
variable "secret_arns" {
  description = "Secrets Manager ARNs by environment variable name. CONVEX_INSTANCE_SECRET goes only to the backend."
  type        = map(string)
}
variable "web_env" {
  description = "Extra non-secret environment variables for the web app (for example LLM_PROVIDER, SCM_ALLOWED_HOSTS)."
  type        = map(string)
  default     = {}
}
variable "offline" {
  description = "Run with OPENREVIEW_OFFLINE=true (only model, embedding, SCM and SSO hosts are contacted)."
  type        = bool
  default     = false
}
variable "egress_cidrs" {
  description = "Destinations tasks may reach. Narrow this (with VPC endpoints) for offline installs."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}
variable "web_count" {
  description = "Number of web tasks."
  type        = number
  default     = 2
}
