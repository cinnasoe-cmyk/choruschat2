# Chorus Railway Safe Rebuild

This version removes SQLite/native database packages so Railway builds more reliably.

## GitHub root should contain

```txt
index.js
package.json
railway.json
public/
.env.example
.gitignore
README.md
```

Do not put these files inside an extra folder.

## Railway variables

```txt
SESSION_SECRET=make-a-long-random-secret
STORAGE_DIR=/app/storage
```

## Railway volume

Mount your volume to:

```txt
/app/storage
```

## Optional for better calls

```txt
TURN_URL=turn:your-turn-host:3478
TURN_USERNAME=your_username
TURN_PASSWORD=your_password
```

## Features

- Discord-style full-screen UI
- Mobile layout
- Saved accounts/messages/profile pictures using JSON file storage
- Friend requests
- DMs and group chats
- Profile picture uploads
- Message edit/delete
- Emoji reactions
- Voice calls using WebRTC signaling
