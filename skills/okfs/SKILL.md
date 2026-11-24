---
name: okfs
description: Show the user a folder of files in their browser with okfs. Use when you have a folder of reports, screenshots, logs or other files that the user must look at, and a list of paths in the chat is not enough.
---

# okfs

okfs is a web file browser in one binary. It serves a folder, read only, and shows each file beside the list. Use it to hand the user one link to a folder you want them to look at.

Check that it is installed with `okfs --version`. If the command is missing, tell the user and give them <https://github.com/jrnxf/okfs/blob/main/docs/install.md>. Do not install it without asking.

## Show a folder

1. Start okfs in the background, because it runs until it is stopped:

   ```sh
   okfs --no-open <dir>
   ```

2. Read the address from its output, on the line that starts with `at`:

   ```text
     serving  /home/user/reports (read only)
     at       http://127.0.0.1:8080/
   ```

3. Give the user that address exactly as printed. The port is 8080, or the next free port after it, so do not guess it.
4. Stop okfs when the user has finished. It stops cleanly on Ctrl-C or SIGTERM.

`--no-open` keeps okfs from opening a browser itself. The link is the thing to hand over.

Serve the smallest folder that holds what the user needs. Everything under it can be read through the link. Dotfiles are left out unless you pass `--hidden`.

## When the user is on another machine

By default okfs listens on `127.0.0.1`, which only the machine it runs on can reach. If the user's browser is on another machine, add `--bind 0.0.0.0`:

```sh
okfs --no-open --bind 0.0.0.0 <dir>
```

okfs then prints one link for each network address, each with a key:

```text
  at       http://127.0.0.1:8080/?key=...
           http://192.168.1.20:8080/?key=...
  key      on: anyone with one of these links can read every file shown
```

The first link is for the machine okfs runs on. The links under it are for other machines: give the user one of those.

- Give the user the whole link, with the key. A request without the key is refused.
- The key is new at every start, so an old link stops working when okfs restarts.
- Without TLS the link travels as plain HTTP. Use this only on a network the user trusts.
- Tell the user that you opened the folder to the network, and stop okfs when they have finished.

Do not add `--no-key`.

## Rules

- Never add `--allow-upload`, `--allow-edit` or `--allow-delete` on your own. They let anyone with the link change the folder. Add one only when the user asks for it by name.
- Never serve a home folder, a folder with secrets, or more than the user asked to see.
- Run `okfs --help` for the other flags. <https://github.com/jrnxf/okfs/blob/main/docs/usage.md> has the full list.
