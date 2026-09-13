from pathlib import Path

# One-time patch retained as documentation of the verified mobile intro migration.
path = Path("index.html")
s = path.read_text()

old_css = '''      .site-intro video {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }'''
new_css = '''      .site-intro img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        object-position: center;
        background: #030303;
      }
      @media (max-width: 819px) {
        .site-intro {
          padding:
            max(10px, env(safe-area-inset-top))
            max(10px, env(safe-area-inset-right))
            max(10px, env(safe-area-inset-bottom))
            max(10px, env(safe-area-inset-left));
        }
        .site-intro img {
          width: 100%;
          height: auto;
          max-height: 100%;
          object-fit: contain;
        }
      }'''

old_html = '''      <video
        id="intro-video"
        muted
        playsinline
        preload="auto"
        poster="assets/rosetta-intro-poster.jpg"
        aria-hidden="true"
      >
        <source src="assets/rosetta-intro.mp4" type="video/mp4" />
      </video>'''
new_html = '''      <img
        id="intro-image"
        src="assets/rosetta-intro-poster.jpg"
        alt=""
        decoding="async"
        fetchpriority="high"
        aria-hidden="true"
      />'''

if old_css not in s:
    raise SystemExit("Expected intro video CSS not found")
if old_html not in s:
    raise SystemExit("Expected intro video markup not found")

s = s.replace(old_css, new_css, 1)
s = s.replace(old_html, new_html, 1)
s = s.replace(
    'const video = document.getElementById("intro-video");',
    'const image = document.getElementById("intro-image");',
    1,
)
s = s.replace('          video.pause();\n', '', 1)
s = s.replace(
    '        video.addEventListener("ended", closeIntro, { once: true });\n'
    '        video.addEventListener("error", closeIntro, { once: true });\n'
    '        closeTimer = setTimeout(closeIntro, 6000);\n\n'
    '        const playback = video.play();\n'
    '        if (playback) playback.catch(closeIntro);',
    '        image.addEventListener("error", closeIntro, { once: true });\n'
    '        closeTimer = setTimeout(closeIntro, 4500);',
    1,
)

if 'id="intro-video"' in s or '.site-intro video' in s:
    raise SystemExit("Intro video replacement did not fully apply")
if 'id="intro-image"' not in s:
    raise SystemExit("Responsive intro image was not added")

path.write_text(s)
