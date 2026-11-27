terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.0"
    }
  }

  backend "s3" {
    bucket       = "pgal-tfstate-asa"
    key          = "pgal/aws/terraform.tfstate"
    region       = "eu-north-1"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region
}

variable "aws_region" {
  type    = string
  default = "eu-north-1"
}

variable "frontend_origin" {
  type        = string
  description = "Allowed origin for S3 CORS — set to the Static Web App URL in production"
  default     = "*"
}

data "aws_caller_identity" "current" {}

# ── S3 photo bucket ────────────────────────────────────────────────────────────

resource "aws_s3_bucket" "photos" {
  bucket        = "pgal-photos-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "photos" {
  bucket = aws_s3_bucket.photos.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  rule {
    id     = "expire-objects"
    status = "Enabled"

    filter {}

    expiration {
      days = 7
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "photos" {
  bucket = aws_s3_bucket.photos.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "GET"]
    allowed_origins = [var.frontend_origin]
    max_age_seconds = 3000
  }
}

# ── DynamoDB ───────────────────────────────────────────────────────────────────

resource "aws_dynamodb_table" "photos" {
  name         = "pgal-photos"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "photoId"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "photoId"
    type = "S"
  }
}

# ── IAM user for the Azure API ─────────────────────────────────────────────────

resource "aws_iam_user" "api" {
  name = "pgal-api"
}

resource "aws_iam_user_policy" "api" {
  name = "pgal-api-policy"
  user = aws_iam_user.api.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.photos.arn}/uploads/*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:Query", "dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.photos.arn
      }
    ]
  })
}

resource "aws_iam_access_key" "api" {
  user = aws_iam_user.api.name
}

# ── Lambda ────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/pgal-photo-processor"
  retention_in_days = 3
}

resource "aws_iam_role" "lambda" {
  name = "pgal-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "pgal-lambda-policy"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:UpdateItem"]
        Resource = aws_dynamodb_table.photos.arn
      }
    ]
  })
}

data "archive_file" "lambda" {
  type        = "zip"
  source_file = "${path.module}/../../lambda/handler.js"
  output_path = "${path.module}/../../lambda/handler.zip"
}

resource "aws_lambda_function" "photo_processor" {
  function_name    = "pgal-photo-processor"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "nodejs22.x"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.photos.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_permission" "s3" {
  statement_id  = "AllowS3Invoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.photo_processor.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.photos.arn
}

resource "aws_s3_bucket_notification" "photos" {
  bucket = aws_s3_bucket.photos.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.photo_processor.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "uploads/"
  }

  depends_on = [aws_lambda_permission.s3]
}

# ── Outputs ────────────────────────────────────────────────────────────────────

output "photos_bucket_name" {
  value = aws_s3_bucket.photos.bucket
}

output "photos_table_name" {
  value = aws_dynamodb_table.photos.name
}

output "api_access_key_id" {
  value     = aws_iam_access_key.api.id
  sensitive = true
}

output "api_secret_access_key" {
  value     = aws_iam_access_key.api.secret
  sensitive = true
}
