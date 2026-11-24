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

resource "azurerm_resource_group" "main" {
  name     = "pgal-rg"
  location = var.azure_region
}
