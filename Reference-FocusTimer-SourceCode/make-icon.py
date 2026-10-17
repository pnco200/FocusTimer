from PIL import Image, ImageDraw
from pathlib import Path

root = Path(__file__).resolve().parent
im = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
d.rounded_rectangle((4, 4, 252, 252), radius=58, fill='#34634d')
d.rounded_rectangle((109, 38, 147, 51), radius=5, fill='#edf3e9')
d.line((128, 51, 128, 65), fill='#edf3e9', width=10)
d.ellipse((57, 64, 199, 206), outline='#edf3e9', width=12)
d.line((128, 91, 128, 135, 160, 153), fill='#edf3e9', width=12, joint='curve')
d.ellipse((121, 128, 135, 142), fill='#edf3e9')
im.save(root / 'Studytime.ico', format='ICO', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
