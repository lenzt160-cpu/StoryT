# StoryT: Railway app

All files sit side by side in one folder, with no subfolders. To publish or update, drag every file onto your GitHub repository (**Add file → Upload files**), then click **Commit changes**. Railway redeploys in about a minute.

**Required once:** in Railway, add a **Volume** mounted at `/data` to the StoryT service. Without it, accounts, videos and messages are erased on every update. The app shows a red "Setup needed" bar until the Volume is connected.

## What the app does
- **Feed** of Tea videos (your own story, up to 4:00) and Gossip videos (about someone's photo or video, up to 6:00), with 👍 👎 😂 ☕ reactions and comments.
- **Recording:** tap Spill, then Tea, and the camera opens with a 3-second countdown. While recording you can switch between the front and back cameras, and use Delete to throw away a take and start over.
- **Follow** creators. Once you follow someone, a **Message** button appears next to Following.
- **Channel:** Messages (your inbox), All, and one circle per creator you follow. Tapping a creator shows only their videos until you tap another circle.
- **Notifications** for new videos from creators you follow, new messages, comments on your videos and new followers. The app asks the first time. On iPhone, people must add StoryT to their Home Screen first (iOS 16.4 or newer).
- **Earnings:** $1 for every 100 👍, while a video's 👍 are ahead of its 👎. Shown only in Profile → Video metrics.

## Settings (optional Railway variables)
| Variable | Default | Meaning |
|---|---|---|
| `DOLLARS_PER_100_LIKES` | `1` | Dollars paid per 100 thumbs up |
| `MIN_WITHDRAW` | `10` | Smallest withdrawal in dollars |
| `MAX_UPLOAD_MB` | `300` | Biggest file a member can upload |
| `PUSH_CONTACT` | `mailto:admin@storyt.app` | Contact email sent with notifications (use your own) |
