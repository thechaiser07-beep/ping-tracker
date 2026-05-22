# PING — Airtable Setup Guide

Takes about 5 minutes. No confusing consoles.

---

## Step 1 — Create a Free Airtable Account

Go to **https://airtable.com** and sign up for free.

---

## Step 2 — Create a New Base

1. Click **"Add a base"** → **"Start from scratch"**
2. Name it **`Ping Tracker`**

---

## Step 3 — Create the 3 Tables

You'll set up 3 tables. Airtable starts you with one called "Table 1" — rename and build from there.

### Table 1 — `Water`

Rename "Table 1" to **`Water`**, then set up these fields:

| Field Name | Field Type     |
|------------|---------------|
| `Date`     | Single line text ← rename the default "Name" field to this |
| `Entries`  | Long text      |

Delete any other default fields Airtable adds.

---

### Table 2 — `Sleep`

Click **"+"** to add a new table, name it **`Sleep`**, then add:

| Field Name | Field Type       |
|------------|-----------------|
| `Date`     | Single line text ← rename "Name" |
| `Bedtime`  | Single line text |
| `Waketime` | Single line text |
| `Duration` | Number (allow decimals) |
| `Quality`  | Number           |
| `Notes`    | Long text        |
| `Type`     | Single line text |

---

### Table 3 — `Settings`

Add another table, name it **`Settings`**, then add:

| Field Name | Field Type |
|------------|-----------|
| `Key`      | Single line text ← rename "Name" |
| `Value`    | Long text  |

---

## Step 4 — Get Your Personal Access Token

1. Go to **https://airtable.com/create/tokens**
2. Click **"Create new token"**
3. Name it anything (e.g. `ping-app`)
4. Under **Scopes**, add:
   - `data.records:read`
   - `data.records:write`
5. Under **Access**, click **"Add a base"** → select **Ping Tracker**
6. Click **"Create token"**
7. **Copy the token now** — Airtable only shows it once

---

## Step 5 — Get Your Base ID

1. Open your **Ping Tracker** base in Airtable
2. Look at the URL — it looks like:
   ```
   https://airtable.com/appXXXXXXXXXXXXXX/tblYYY...
   ```
3. Your Base ID is the part starting with **`app`** — copy it

---

## Step 6 — Enter Your Credentials in the App

Open `index.html` in your browser, set your PIN, then open **Settings** (the sliders icon in the sidebar).

Scroll down to the **AIRTABLE TOKEN** and **AIRTABLE BASE ID** fields, paste your values from Steps 4 and 5, then click **SAVE AIRTABLE CONFIG**.

Your credentials are stored in your browser's local storage — they never need to go in the code.

---

## Step 7 — Open the App

Open `index.html` in Chrome, Edge, or Firefox.

- First launch: set your 4-digit PIN
- The small dot next to "PING" in the sidebar shows sync status:
  - **Green** = synced to Airtable
  - **Yellow pulse** = saving…
  - **Pink** = sync error (data is safe locally, will retry next save)

---

## How Your Data Looks in Airtable

You can open Airtable anytime and see/edit your data like a spreadsheet. Each row in **Water** is one day's entries (stored as JSON). Each row in **Sleep** is one night. Clean and browsable.

---

## Offline Mode

The app works without internet. Everything saves to your browser's local storage first, then syncs to Airtable in the background. If Airtable is unreachable, the dot turns pink — your data is safe locally.
