from pathlib import Path

path = Path("index.html")
s = path.read_text()

old = '''      @media (max-width: 819px) {
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

new = '''      @media (max-width: 819px) {
        .site-intro {
          padding:
            max(28px, env(safe-area-inset-top))
            max(22px, env(safe-area-inset-right))
            max(28px, env(safe-area-inset-bottom))
            max(22px, env(safe-area-inset-left));
        }
        .site-intro img {
          width: auto;
          height: auto;
          max-width: 90vw;
          max-height: 84svh;
          object-fit: contain;
          object-position: center;
        }
      }'''

if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit("Expected mobile intro CSS not found")

path.write_text(s)
