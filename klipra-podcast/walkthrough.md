# Walkthrough - Klipra Podcast Studio

The podcast recording studio has been renamed to **Klipra Podcast Studio** (`klipra-podcast`) and integrated directly inside your existing **Klipra** video platform at `/Volumes/Data/AntiGravity/Klipra`.

---

## 🛠️ Upgrades & Integration Details

1.  **Product Integration**: Added "Podcast Studio" to the main Klipra frontend dashboard, complete with navigation routes, sidebar tabs, and homepage explainers.
2.  **Dockerization**: The app is now a fully containerized service named `podcast` inside your `docker-compose.yml`. It runs automatically when your Klipra stack starts up!
3.  **Local & Remote Hosting**:
    *   **Dashboard Integration**: Navigating to the **Podcast Studio** tab inside the Klipra dashboard (`http://localhost:5175`) renders the recording studio directly in an iframe with full permission delegations (webcam, mic, and screen share).
    *   **Localtunnel URL**: `https://klipra-podcast-v24i.loca.lt`
    *   **Bypass Password**: `119.73.121.78` (Enter this if localtunnel prompts for a password).
4.  **Global Scrolling Bug Fix**: Fixed a critical CSS layout issue in `App.jsx` where the main wrapper had a redundant `h-full` class. This was pushing elements off the bottom of the screen on laptops. The scrollbar now appears and functions correctly for all configurations and views.

---

## 🎙️ Video & Audio Quality Explanation

To ensure "podcast-grade" quality, the system uses two separate pipelines:

1.  **Live Call Connection (WebRTC)**:
    *   This is the real-time stream you see and hear to converse with your guest.
    *   It uses smart, real-time compression to keep delay below 100ms. If either person's internet lags, it only affects this live preview.
2.  **Direct Recording (MediaRecorder API)**:
    *   This records the camera and mic feed **directly on the participant's device** *before* any transmission.
    *   **Video**: Recorded in high-bitrate HD (up to 4 Mbps).
    *   **Audio**: Recorded in CD-quality stereo (256 kbps, 48 kHz).
    *   **Zero Internet Dependency**: If the internet jitters, freezes, or disconnects temporarily during the call, **the recording remains 100% perfect, smooth, and high-definition**.
    *   **Unprocessed Acoustics**: If both you and your guest wear headphones, you can toggle off **Echo Cancellation** and **Noise Suppression** in the lobby. This records the microphone's raw acoustic depth without browser filtering.

---

## 🚀 How to Verify & Test the Upgrades

### Step 1: Open the Main Klipra Dashboard
1. Open your browser and navigate to the Klipra dashboard at **[http://localhost:5175](http://localhost:5175)** (or the hosted localtunnel link if active).
2. On the landing page, notice the new **Podcast Studio** CTA and navbar tab.
3. Click the **Podcast Studio** tab. The dashboard will load the embedded podcast studio.
4. Verify that you can now scroll down smoothly if options are expanded.

### Step 2: Set up Direct-to-Disk Recording
1. In the embedded studio lobby, select your camera and mic inputs. Toggle **Blur Background** to test video processing.
2. Click **Enter Studio Room**.
3. Click **Start Recording**. When prompted by the browser, select a folder on your Mac (e.g., `Downloads/podcast.webm`) to stream your session directly to disk.

### Step 3: Connect a Guest (No Installation Needed)
1. Copy the invite link from the studio placeholder.
2. Send the guest invite link or open it in a separate Incognito browser window: **[https://klipra-podcast-v24i.loca.lt](https://klipra-podcast-v24i.loca.lt)**.
3. If localtunnel prompts for a password, enter `119.73.121.78`.
4. Join the room as a Guest. Verify that the video feeds connect and both waveforms react to audio.

### Step 4: Screen Share, Annotations, and Layout changes
1. In the Guest window, click the screen button to start screen sharing.
2. The Host view will automatically switch to **Theater Mode** (shared screen on the left, host/guest stacked on the right).
3. Switch layouts in the Host window to **Overlay (PiP) Mode** or **Grid Mode**. Observe the guest's layout update in real time.
4. Draw on the shared screen inside the Guest window. Confirm the drawings appear instantly in both views.
