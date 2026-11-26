terraform {
  required_version = ">= 1.9.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  backend "azurerm" {
    resource_group_name  = "pgal-tfstate-rg"
    storage_account_name = "pgaltfstateasa"
    container_name       = "tfstate"
    key                  = "pgal/azure/terraform.tfstate"
    use_azuread_auth     = true
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy = true
    }
  }
}

variable "azure_region" {
  type    = string
  default = "northeurope"
}

variable "entra_client_id" {
  type    = string
  default = "7e709590-8b26-4044-b0e2-f93fc367ceb9"
}

variable "entra_tenant_id" {
  type    = string
  default = "8b5d7600-e426-4843-b8d8-852678ba6e51"
}

data "azurerm_client_config" "current" {}

# ── Remote state: read AWS outputs ────────────────────────────────────────────

data "terraform_remote_state" "aws" {
  backend = "s3"
  config = {
    bucket  = "pgal-tfstate-asa"
    key     = "pgal/aws/terraform.tfstate"
    region  = "eu-north-1"
    encrypt = true
  }
}

# ── Resource group ────────────────────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = "pgal-rg"
  location = var.azure_region
}

# ── Static Web App ────────────────────────────────────────────────────────────

resource "azurerm_static_web_app" "frontend" {
  name                = "pgal-frontend"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku_tier            = "Free"
  sku_size            = "Free"
}

# ── Storage account for Function App ─────────────────────────────────────────

resource "azurerm_storage_account" "functions" {
  name                     = "pgalfnstore${substr(md5(azurerm_resource_group.main.id), 0, 6)}"
  resource_group_name      = azurerm_resource_group.main.name
  location                 = azurerm_resource_group.main.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

# ── Flex Consumption Function App ─────────────────────────────────────────────

resource "azurerm_service_plan" "functions" {
  name                = "pgal-fn-plan"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  os_type             = "Linux"
  sku_name            = "FC1"
}

resource "azurerm_linux_function_app" "api" {
  name                       = "pgal-api"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  storage_account_name       = azurerm_storage_account.functions.name
  storage_account_access_key = azurerm_storage_account.functions.primary_access_key
  service_plan_id            = azurerm_service_plan.functions.id

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      node_version = "20"
    }
  }

  app_settings = {
    ENTRA_TENANT_ID = var.entra_tenant_id
    ENTRA_CLIENT_ID = var.entra_client_id
    AWS_REGION      = "eu-north-1"
    BUCKET_NAME     = data.terraform_remote_state.aws.outputs.photos_bucket_name
    TABLE_NAME      = data.terraform_remote_state.aws.outputs.photos_table_name

    AWS_ACCESS_KEY_ID     = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.aws_key_id.versionless_id})"
    AWS_SECRET_ACCESS_KEY = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.aws_secret_key.versionless_id})"

    WEBSITE_CORS_ALLOWED_ORIGINS = azurerm_static_web_app.frontend.default_host_name
  }
}

# ── Key Vault ─────────────────────────────────────────────────────────────────

resource "azurerm_key_vault" "main" {
  name                       = "pgal-kv"
  resource_group_name        = azurerm_resource_group.main.name
  location                   = azurerm_resource_group.main.location
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = false
}

# Pipeline identity can manage secrets (needed to write them on first deploy)
resource "azurerm_role_assignment" "pipeline_kv_officer" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = data.azurerm_client_config.current.object_id
}

# Function App identity can read secrets
resource "azurerm_role_assignment" "api_kv_reader" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_linux_function_app.api.identity[0].principal_id
}

resource "azurerm_key_vault_secret" "aws_key_id" {
  name         = "aws-access-key-id"
  value        = try(data.terraform_remote_state.aws.outputs.api_access_key_id, "placeholder")
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.pipeline_kv_officer]
}

resource "azurerm_key_vault_secret" "aws_secret_key" {
  name         = "aws-secret-access-key"
  value        = try(data.terraform_remote_state.aws.outputs.api_secret_access_key, "placeholder")
  key_vault_id = azurerm_key_vault.main.id

  depends_on = [azurerm_role_assignment.pipeline_kv_officer]
}

# ── Outputs ───────────────────────────────────────────────────────────────────

output "static_web_app_url" {
  value = "https://${azurerm_static_web_app.frontend.default_host_name}"
}

output "function_app_url" {
  value = "https://${azurerm_linux_function_app.api.default_hostname}"
}
