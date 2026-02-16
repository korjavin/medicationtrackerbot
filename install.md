# 🚀 Installation Guide

This guide will walk you through setting up your own **Medication Tracker Bot**. 

The installer automates the complex parts (Docker, SSL certificates, Nginx/Traefik configuration), asking you simple questions to customize your setup. By the end, you will have a fully functional web app and Telegram bot running on your own server.

## 👋 Introduction

### Why a Separate Server?
We strongly advise using a **dedicated server (VPS)** rather than a shared hosting environment. 

*   **Privacy**: This is your medical data. Hosting it on your own private server ensures that **no one else**—including us—has access to it. It stays 100% yours.
*   **Security**: Securing a dedicated isolated environment is simpler and more robust than shared hosting.
*   **Simplicity**: Our "Simpler is Better" philosophy means you don't need complex cloud infrastructures. Any provider works (Digital Ocean, AWS, Google Cloud, etc.), but a simple VPS is best.

**Network Requirements**:
You only need 2 open ports:
*   `22` for SSH (Secure Shell)
*   `80` / `443` (or `8443`) for the Website (HTTPS)
*   *All other ports can be safely blocked by your firewall.*

---

## 🛠 Prerequisites

Before running the installer, ensure you have the following:

### 1. A Linux Server (VPS)
You need a server running **Ubuntu** (22.04+ recommended) or **Debian**.
- **Recommended**: Hetzner (CX22 instance) or Digital Ocean ($4-6 Dropet).
- **Hardware**: Only 1 CPU and 1GB RAM needed (very lightweight).
- **Public IP**: You need a public IPv4 address.
- **Firewall**: Ports `80` (HTTP) and `443` (HTTPS) must be open.

### 2. A Domain Name
You need a domain name to access your tracker securely (HTTPS). Create **A Records** that point to your server's IP address.

### 3. Telegram Bot Token
1. Open **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` and follow the prompts to get your token.
3. Send `/setdomain` to BotFather and enter your domain name.

### 4. Your Telegram User ID
Open **[@userinfobot](https://t.me/userinfobot)** and copy the numeric ID.

---

## 📥 Installation

### Step 1: Connect to Your Server
SSH into your server:
```bash
ssh root@<your-server-ip>
```

### Step 2: Download & Run Installer
Run these commands to download and start the interactive wizard. 

> [!TIP]
> Always check for the latest version on the [**Releases**](https://github.com/korjavin/medicationtrackerbot/releases) page. Replace `v0.1.3` in the commands below with the latest version number if available.

```bash
wget https://github.com/korjavin/medicationtrackerbot/releases/download/v0.1.3/medtracker-installer_linux_amd64.tar.gz
tar xf medtracker-installer_linux_amd64.tar.gz 
./medtracker-installer 
```

---

## 📖 Next Steps

The installer will ask you a series of questions. We generally recommend accepting the default values (just press Enter) unless you have a specific reason to change them.

For a more detailed walkthrough of the settings, see [docs/installer.md](docs/installer.md).

---
*Last Updated: 2026-02-16*
