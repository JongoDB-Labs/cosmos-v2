# Slack notifications

Cosmos can send two notifications to people as direct messages in Slack: an item
assigned to them, and an @mention of them in a work-item comment. Each message has
the item's key and a link back to Cosmos, and its title where the organization
allows it (see "What a message says").

There are three steps, each done by a different person:

1. **The Cosmos operator** creates one Slack app for the instance and gives Cosmos
   its client ID and secret.
2. **An org admin** adds that app to their Slack workspace (Settings, Integrations,
   Slack notifications, Add to Slack).
3. **Members** are linked by email automatically, and choose what they get on
   Settings, Profile.

Cosmos only calls Slack. It takes no requests from Slack (no events, slash
commands or buttons), so it needs no signing secret and no inbound URL other than
the OAuth redirect.

## 1. Create the Slack app (operator)

At <https://api.slack.com/apps>, choose Create New App, From a manifest, and paste
this, with your instance's public address in place of `cosmos.example.com`:

```yaml
display_information:
  name: Cosmos
  description: Assignments and mentions from Cosmos.
features:
  bot_user:
    display_name: Cosmos
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
oauth_config:
  redirect_urls:
    - https://cosmos.example.com/api/v1/slack/oauth/callback
  scopes:
    bot:
      - chat:write
      - im:write
      - users:read
      - users:read.email
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

The scopes, and nothing more. An install that grants Cosmos fewer or more than
these is refused, so keep the app's bot token scopes exactly as listed:

| Scope | Why |
| --- | --- |
| `chat:write` | Post the message. |
| `im:write` | Open the direct message with the member. |
| `users:read`, `users:read.email` | Find the member by their email address. |

Keep **token rotation off**: Cosmos stores the bot token Slack issues at install and
doesn't refresh it. If more than one Slack workspace will add the app, turn on
Manage Distribution (a Slack Marketplace listing isn't needed). An Enterprise Grid
organization-wide install is refused; add the app to one workspace.

The redirect URL is always `https://<your Cosmos address>/api/v1/slack/oauth/callback`.
The admin screen shows the exact value for the address it is opened at. If people
reach Cosmos at more than one address, register each one.

Then set, from the app's Basic Information page:

| Variable | Value |
| --- | --- |
| `SLACK_CLIENT_ID` | The app's Client ID. |
| `SLACK_CLIENT_SECRET` | The app's Client Secret. Treat it as a secret: inject it the way you inject other secrets, never in an image or a `NEXT_PUBLIC_` variable. |
| `COSMOS_PUBLIC_URL` | Recommended. The address links in messages point to. Unset, they point to the address the admin added the app from. |
| `SLACK_API_ORIGIN` | Leave unset. Only for tests and local stand-ins (https, or http on localhost). |

Restart Cosmos. Until both Slack values are set, the admin screen shows these steps
instead of Add to Slack.

## 2. Connect a workspace (org admin)

Settings, Integrations, Slack notifications, **Add to Slack**. Slack shows the four
permissions above; allow them. You need permission to manage integrations, and you
come back to the same screen with the result.

The bot token is sealed in Cosmos's credential store. No screen or API returns it.
**Disconnect** revokes it at Slack and deletes it, along with every message still
waiting. Members' choices (what they get, or that they unlinked) are kept.

A Slack workspace connects to one Cosmos organization. Slack gives the app one
token per workspace, so two organizations on one workspace would share it, and
either one disconnecting would cut off both. If another organization on this
instance already connected the workspace, Add to Slack says so; disconnect it
there first. Connecting to a different workspace than before revokes the old
workspace's token.

The screen also shows whether messages are getting through: when the last one was
sent, the last error Slack returned, and how many are waiting. "Not sending:
reconnect Slack" means Slack no longer accepts the token (the app was removed, or
the token revoked); Add to Slack again fixes it.

## 3. Linking members

A member is linked to the Slack account with the same email address, and only when
Slack says they confirmed that address. Members in a different workspace, bots and
deactivated Slack accounts are never linked. Matching happens the first time a
notification is due for someone, or for everyone at once with **Match members by
email**.

Two Cosmos members can share an email address. If both match one Slack account, the
second waits as "Shares a Slack account", and nothing is sent to them until an
admin chooses **Allow**. Allowing it sends that member's notifications to whoever
owns the Slack account, so admins can't allow their own.

Each member sees their own link on Settings, Profile. They can turn either kind
of message off (both off sends nothing), unlink (Cosmos then never links them
again by itself), and link again.

## What a message says

The heading ("Assigned to you" or "You were mentioned"), the item's key as a link,
and the title. The title is left out, and the message says "Restricted", when:

- the organization doesn't let titles leave Cosmos by email. That's Settings,
  Organization, Query language, "Include titles in filter emails" (shown once the
  query language is turned on): on by default for commercial organizations, off
  for government ones; or
- the item is restricted by its classification marking.

Never the description, and never the comment's text.

Each message is decided when it's sent, as the person it goes to: they must still
be a member whose role reads notifications (guests and billing admins get none,
as with the bell), still be linked, still want that kind of message, and still be
able to open the item. If not, nothing is sent.

## Delivery and failures

Changes in Cosmos only queue a message; the `slack-outbox` job sends them every 15
seconds, so Slack being slow or down never slows or fails the change. A failed send
is retried up to six times, backing off from 30 seconds (or as long as Slack's
Retry-After asks). A message more than an hour old is dropped rather than sent
late. Every failure is counted in the jobs readout, logged with Slack's error code
(never the token), and shown on the admin screen.

One organization's trouble doesn't hold up another's. When Slack rate-limits an
organization, Cosmos stops calling Slack for it until Slack's wait is over, and its
messages wait. When an organization's stored token can't be read (for example, the
vault key it was sealed with was retired before secrets were re-wrapped), the admin
screen shows `credential_unreadable` and its messages wait; Add to Slack again
fixes it.

Delivery is at least once. If Slack takes a message but its answer doesn't arrive
in time, the retry sends it again, so a member can, rarely, get the same message
twice.
