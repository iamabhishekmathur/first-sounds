# Regenerates banner and legacy launcher icon PNGs. Requires Pillow.
from PIL import Image, ImageDraw, ImageFont
BG, ACC, TXT = "#FFF3E3", "#E2672E", "#3A2A22"
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
res = "app/src/main/res/"
# banner 640x360 px in xhdpi = 320x180 dp
im = Image.new("RGB", (640, 360), BG); d = ImageDraw.Draw(im)
d.rectangle([0, 300, 640, 360], fill=ACC)
d.ellipse([60, 70, 190, 200], fill=ACC)
big = ImageFont.truetype(F, 110); d.text((125, 120), "S", font=big, fill=BG, anchor="mm")
t = ImageFont.truetype(F, 64)
d.text((215, 105), "First", font=t, fill=TXT, anchor="lm")
d.text((215, 185), "Sounds", font=t, fill=ACC, anchor="lm")
im.save(res + "drawable-xhdpi/banner.png")
# legacy icon 192px
ic = Image.new("RGB", (192, 192), BG); d = ImageDraw.Draw(ic)
d.ellipse([16, 16, 176, 176], fill=ACC)
d.text((96, 100), "S", font=ImageFont.truetype(F, 120), fill=BG, anchor="mm")
ic.save(res + "mipmap-xxxhdpi/ic_launcher.png")
