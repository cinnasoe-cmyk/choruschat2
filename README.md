# Chorus Render Ready

Use these files for Render.

## GitHub root should contain

```txt
index.js
package.json
render.yaml
public/
.env.example
.gitignore
README.md
```

Do not put these files inside an extra folder.

## Render setup

Build Command:

```txt
npm install
```

Start Command:

```txt
npm start
```

Environment variables:

```txt
SESSION_SECRET=make-a-long-random-secret
STORAGE_DIR=/var/data
```

Persistent Disk:

```txt
Name: chorus-data
Mount Path: /var/data
Size: 1 GB
```

## Optional for better calls

```txt
TURN_URL=turn:your-turn-host:3478
TURN_USERNAME=your_username
TURN_PASSWORD=your_password
```
