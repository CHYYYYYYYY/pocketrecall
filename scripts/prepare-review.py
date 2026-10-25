"""Prepare a small, attributed TUM RGB-D replay (Pillow, NumPy, ffmpeg).

Usage: python scripts/prepare-review.py /path/to/rgbd_dataset_freiburg1_desk.tgz
Download from the official URL documented in public/assets/review/ATTRIBUTION.md.
Only image processing and sensor geometry happen here; Gemini runs separately.
"""
import hashlib
import json
import pathlib
import subprocess
import sys
import tarfile
import tempfile

import numpy as np
from PIL import Image

root = pathlib.Path(__file__).resolve().parents[1]
output = root / 'public/assets/review'
output.mkdir(parents=True, exist_ok=True)
archive = pathlib.Path(sys.argv[1])
prefix = 'rgbd_dataset_freiburg1_desk/'

with tarfile.open(archive, 'r:gz') as tar:
    members = tar.getmembers()
    def rows(name):
        return [line.split() for line in tar.extractfile(prefix + name).read().decode().splitlines()
                if line.strip() and not line.startswith('#')]
    rgb = [(float(r[0]), prefix+r[1]) for r in rows('rgb.txt')]
    depth = [(float(r[0]), prefix+r[1]) for r in rows('depth.txt')]
    groundtruth = np.array([[float(v) for v in row] for row in rows('groundtruth.txt')])
start = rgb[0][0] + .5
# Select captures with synchronized depth and reference pose; Kinect drops frames.
depth_times=np.array([r[0] for r in depth])
valid_rgb=[r for r in rgb if min(abs(depth_times-r[0]))<=.025 and min(abs(groundtruth[:,0]-r[0]))<=.025]
start=min(r[0] for r in valid_rgb if r[0]>=start)
duration = min(21., rgb[-1][0]-start)
offsets = np.linspace(0, duration-1, 8)
chosen = [min(valid_rgb, key=lambda r: abs(r[0]-start-t)) for t in offsets]
video_rgb = [min(rgb, key=lambda r: abs(r[0]-start-t)) for t in np.arange(0, duration, 1/15)]
chosen_depth = [min(depth, key=lambda d: abs(d[0]-r[0])) for r in chosen]
needed = set(n for _, n in chosen+video_rgb+chosen_depth)

def matrix(row):
    x,y,z,w = row[4:8] / np.linalg.norm(row[4:8])
    mat=np.eye(4)
    mat[:3,:3]=[[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)],
               [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)],
               [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]]
    mat[:3,3]=row[1:4]
    return mat

with tempfile.TemporaryDirectory(prefix='pocketrecall-tum-') as directory:
    directory=pathlib.Path(directory)
    # Sequential reading avoids repeatedly decompressing a large archive.
    with tarfile.open(archive, 'r|gz') as tar:
        for member in tar:
            if member.name in needed:
                dest=directory/member.name
                dest.parent.mkdir(parents=True,exist_ok=True)
                dest.write_bytes(tar.extractfile(member).read())
    first_gt=groundtruth[np.abs(groundtruth[:,0]-chosen[0][0]).argmin()]
    # One deterministic world frame: first camera at origin, optical Y/Z flipped.
    normalize=np.diag([1.,-1.,-1.,1.]) @ np.linalg.inv(matrix(first_gt))
    frames=[]
    for i,((timestamp,rgb_name),(depth_time,depth_name)) in enumerate(zip(chosen,chosen_depth)):
        gt=groundtruth[np.abs(groundtruth[:,0]-timestamp).argmin()]
        if abs(depth_time-timestamp)>.025 or abs(gt[0]-timestamp)>.025:
            raise ValueError('Capture synchronization exceeds 25 ms')
        canvas=Image.new('RGB',(518,518))
        canvas.paste(Image.open(directory/rgb_name).convert('RGB').resize((518,389),Image.Resampling.LANCZOS),(0,64))
        image_name=f'frame-{i:02}.jpg'; canvas.save(output/image_name,quality=90)
        measured=Image.new('I',(518,518))
        measured.paste(Image.open(directory/depth_name).resize((518,389),Image.Resampling.NEAREST),(0,64))
        values=np.array(measured.resize((130,130),Image.Resampling.NEAREST)).astype(float)/5000
        pose=normalize @ matrix(gt)
        geometry={'coordinateUnits':'meters','provenance':{'kind':'sensor','source':'TUM RGB-D fr1/desk: Kinect depth + motion-capture pose'},
                  'pose':{'mapId':'tum-fr1-desk','trackingState':'tracking','worldFromCamera':pose.flatten().tolist()},
                  'intrinsics':{'width':518,'height':518,'fx':525*518/640,'fy':525*389/480,'cx':319.5*518/640,'cy':239.5*389/480+64},
                  'depth':{'width':130,'height':130,'data':values.flatten().tolist()}}
        geometry_name=f'geometry-{i:02}.json';(output/geometry_name).write_text(json.dumps(geometry,separators=(',',':'))+'\n')
        frames.append({'videoTime':round(float(timestamp-start),6),'datasetTimestamp':timestamp,'depthTimeOffsetMs':round((depth_time-timestamp)*1000,3),'poseTimeOffsetMs':round((gt[0]-timestamp)*1000,3),
                       'image':image_name,'imageSha256':hashlib.sha256((output/image_name).read_bytes()).hexdigest(),'geometry':geometry_name})
    # RGB samples at 15 fps; no interpolation or invented camera motion.
    movie=directory/'movie';movie.mkdir()
    for i,(_,name) in enumerate(video_rgb):
        (movie/f'{i:05}.png').symlink_to(directory/name)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-framerate','15','-i',str(movie/'%05d.png'),'-c:v','libx264','-pix_fmt','yuv420p','-crf','25','-movflags','+faststart',str(output/'desk.mp4')],check=True)

manifest={'schemaVersion':1,'source':{'dataset':'TUM RGB-D / freiburg1_desk','url':'https://cvg.cit.tum.de/data/datasets/rgbd-dataset','license':'CC BY 4.0','geometry':'Measured Kinect depth and recorded motion-capture camera poses; not our SLAM estimates','perception':'Gemini results recorded separately; see per-frame metadata'},
          'video':{'url':'/assets/review/desk.mp4','name':'desk.mp4','width':640,'height':480,'duration':len(video_rgb)/15},
          'entities':[{'id':'keyboard','label':'Keyboard','aliases':['keyboard','键盘'],'priority':'explicit'},
                      {'id':'mouse','label':'Mouse','aliases':['mouse','鼠标'],'priority':'explicit'},
                      {'id':'mug','label':'Mug','aliases':['mug','cup','杯子'],'appearance':'the white drinking mug near the keyboard','priority':'explicit'}],
          'frames':frames}
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'frames':len(frames),'videoSeconds':manifest['video']['duration'],'geometry':'measured depth + reference pose','next':'node --env-file=.env.local scripts/record-review-vision.mjs'}))
