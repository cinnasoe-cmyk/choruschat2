# Chorus - Glass DM Home

This update makes Chorus feel more like a private-message-first app.

Included:
- DM-first landing page
- no auto-created starter space for new accounts
- minimal music-note logo
- glassy floating UI
- cleaner settings menu with tabs
- full-screen browser layout
- spaces still available if you want them
- channels
- direct messages
- group chats
- friend requests
- calls and screen sharing

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

## Render
Build Command:
```txt
npm install
```

Start Command:
```txt
npm start
```

Environment Variables:
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


## This patch
- fixes oversized message composer/send box
- makes DMs the default home view
- only shows server channels after clicking a server
- hides server channels again when opening a DM


## This patch
- Call / Share / Clear buttons only show after opening a DM or group chat.
- The landing page is DM-first and does not open a server automatically.
- The music-note logo in the top-left returns users to the DM/home page.
- Server channels only show while a server is selected.
- New accounts no longer get an auto-created server.
- Old auto-created starter servers are removed on startup.
- Default profile picture is now a simple user icon until changed.
- Storage is more reliable and uses `/var/data` automatically on Render when available.

## Important for data saving on Render
Make sure your Render service has a persistent disk:
- Name: `chorus-data`
- Mount path: `/var/data`
- Size: `1 GB`

And keep this environment variable:
```txt
STORAGE_DIR=/var/data
```
