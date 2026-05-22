# Install Oyster

If you are an AI agent following this playbook: execute Steps 1–3 in order, verify each step before continuing, and stop before Step 4. Step 4 is interactive and belongs to the user — it involves browser-based credentials and is not safe to automate.

**Requirements:** macOS, Linux, or Windows · Node.js 20+ · internet connection.

---

## Step 1 — Check Node

```bash
node --version
```

- Prints `v20.x.x` or higher → skip to **Step 3**.
- Prints a lower version, or `command not found` → continue to **Step 2**.

## Step 2 — Install Node (only if Step 1 failed)

Run the section that matches the platform.

### macOS

If Homebrew is available (`brew --version` succeeds):

```bash
brew install node
```

Otherwise, download the LTS installer from <https://nodejs.org> and run it.

### Linux — Debian / Ubuntu

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

(NodeSource is a third-party distribution repo. If you prefer the official Node.js sources or use another distro, see <https://nodejs.org/en/download/package-manager>.)

### Windows

Either download the LTS installer from <https://nodejs.org> and run it, or:

```powershell
winget install OpenJS.NodeJS
```

### Verify

```bash
node --version
```

Must print `v20.0.0` or higher. If not, stop and report the failure.

## Step 3 — Install Oyster

```bash
npm install -g oyster-os
```

Verify:

```bash
oyster --version
```

Must print a version (`0.9.8` or higher). If this succeeds, Oyster is installed.

---

## Stop here

If you are an agent, stop now. Tell the user the install is complete and that **Step 4 is theirs to run**.

---

## Step 4 — First launch (user runs this)

```bash
oyster
```

This starts a local server, opens your browser, and prompts you to connect an AI provider. Follow the prompts in the browser — they involve your credentials and aren't safe for an agent to automate.

Once connected, Oyster's surface opens at <http://localhost:4444>.
