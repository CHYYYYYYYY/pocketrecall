"""Reproducible SYNTHETIC first-person test clip. No AI or real capture claims.
Generates matching RGB, optical poses, boxes, depth and a sparse scene cloud.
Run with Python standard library + ffmpeg. Only generated assets are runtime inputs.
"""
from pathlib import Path
import json, math, subprocess, random

OUT = Path(__file__).resolve().parents[1] / 'public' / 'assets'
OUT.mkdir(parents=True, exist_ok=True)
W, H, FPS, DURATION = 960, 600, 12, 24
F = 740
OBJECTS = {'keys':[-.55,.79,-.68], 'wallet':[.50,.80,-1.10], 'earbuds':[.12,.82,-.50], 'phone':[-.30,.79,-1.27]}
COLORS = {'keys':'#d8f296', 'wallet':'#aa785e', 'earbuds':'#e4e7df', 'phone':'#839b9a'}

def add(a,b): return [x+y for x,y in zip(a,b)]
def sub(a,b): return [x-y for x,y in zip(a,b)]
def mul(v,s): return [x*s for x in v]
def dot(a,b): return sum(x*y for x,y in zip(a,b))
def cross(a,b): return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]]
def normalize(v): return mul(v,1/math.sqrt(dot(v,v)))
def pose(t):
    pos = [.40*math.sin(t*.20), 1.48+.04*math.sin(t*.31), .64+.14*math.cos(t*.17)]
    forward = normalize(sub([.16*math.sin(t*.13), .78, -.90],pos))
    right = normalize(cross(forward, [0,1,0])); down = cross(forward,right)
    m=[[right[i],down[i],forward[i],pos[i]] for i in range(3)]+[[0,0,0,1]]
    return m

def project(p,m):
    delta=sub(p,[m[i][3] for i in range(3)])
    q=[sum(m[j][i]*delta[j] for j in range(3)) for i in range(3)]
    if q[2] <= .01: return None
    return [W/2+F*q[0]/q[2], H/2+F*q[1]/q[2], q[2]]

def cuboid(center,size,color):
    x,y,z=center; a,b,c=[v/2 for v in size]
    pts=[[x+dx*a,y+dy*b,z+dz*c] for dx,dy,dz in [(-1,-1,-1),(1,-1,-1),(1,-1,1),(-1,-1,1),(-1,1,-1),(1,1,-1),(1,1,1),(-1,1,1)]]
    rgb=tuple(int(color[i:i+2],16) for i in [1,3,5])
    return [( [pts[j] for j in ids], tuple(int(v*s) for v in rgb)) for ids,s in [([0,1,5,4],.66),([1,2,6,5],.80),([2,3,7,6],.74),([3,0,4,7],.64),([4,5,6,7],1)] ]

def scene(t):
    polys=[]
    polys += [([[-3,0,-3],[3,0,-3],[3,0,3],[-3,0,3]],'#252d2b')]
    polys += [([[-3,0,-2.7],[3,0,-2.7],[3,3,-2.7],[-3,3,-2.7]],'#39433f')]
    polys += [([[-3,0,-2.7],[-3,0,3],[-3,3,3],[-3,3,-2.7]],'#303b37')]
    polys += cuboid([0,.71,-.95],[2.45,.10,1.45],'#a88e68')
    for x in [-1.05,1.05]:
        for z in [-1.52,-.4]: polys += cuboid([x,.35,z],[.07,.70,.07],'#3d4741')
    polys += cuboid([0,1.20,-1.50],[1.04,.68,.065],'#182b2c')
    polys += cuboid([0,1.21,-1.455],[.94,.55,.012],'#6e9990')
    polys += cuboid([0,.85,-1.50],[.08,.20,.08],'#4c5a54')
    polys += cuboid([0,.77,-1.46],[.35,.03,.20],'#4c5a54')
    polys += cuboid([-.04,.775,-1.12],[.60,.035,.18],'#45534f')
    for j in range(3):
        for k in range(12): polys+=cuboid([-.3+k*.046,.799,-1.18+j*.045],[.034,.009,.03],'#9eaaa0')
    polys+=cuboid([-.98,.90,-1.36],[.22,.28,.22],'#bd9276')
    for i in range(7):
        a=i*.9
        polys+=cuboid([-.98+math.sin(a)*.1,1.10+i*.025,-1.36+math.cos(a)*.1],[.09,.25,.06],'#719575')
    polys+=cuboid([.93,.79,-1.33],[.31,.04,.40],'#7b94ab')
    polys+=cuboid([.94,.84,-1.35],[.29,.05,.38],'#d7cba9')
    positions={k:list(v) for k,v in OBJECTS.items()}
    if t >= 8: positions['keys']=[.61,.79,-.59]
    sizes={'keys':[.18,.025,.09],'wallet':[.20,.05,.14],'earbuds':[.12,.07,.09],'phone':[.10,.025,.19]}
    for k,p in positions.items():
        if k=='keys':
            if 14 <= t < 20: continue
            polys+=cuboid([p[0]-.04,p[1],p[2]],[.065,.02,.055],'#e3d9ad')
            polys+=cuboid([p[0]+.03,p[1],p[2]],[.11,.015,.022],'#c9d3cd')
            polys+=cuboid([p[0]+.07,p[1],p[2]+.015],[.018,.015,.03],'#c9d3cd')
        else: polys+=cuboid(p,sizes[k],COLORS[k])
    if 14 <= t < 20: polys+=cuboid([.61,.83,-.59],[.34,.065,.26],'#ded4b8')
    return polys,positions,sizes

def render(t):
    pixels=bytearray(bytes.fromhex('24302d')*(W*H)); m=pose(t)
    polygons,positions,sizes=scene(t)
    projected=[]
    for index,(points,color) in enumerate(polygons):
        pts=[project(p,m) for p in points]
        if any(p is None for p in pts): continue
        projected.append((sum(p[2] for p in pts)/len(pts),[(p[0],p[1]) for p in pts],color,index>=28))
    for _,pts,color,_ in sorted(projected,key=lambda v:(v[3],-v[0])):
        rgb=bytes.fromhex(color[1:]) if isinstance(color,str) else bytes(color)
        y0=max(0,int(min(p[1] for p in pts))); y1=min(H-1,int(max(p[1] for p in pts))+1)
        for y in range(y0,y1+1):
            scan=y+.5; xs=[]
            for a,b in zip(pts,pts[1:]+pts[:1]):
                if min(a[1],b[1])<=scan<max(a[1],b[1]): xs.append(a[0]+(scan-a[1])/(b[1]-a[1])*(b[0]-a[0]))
            xs.sort()
            for k in range(0,len(xs)-1,2):
                left=max(0,int(xs[k])); right=min(W,int(xs[k+1])+1)
                if right>left: pixels[(y*W+left)*3:(y*W+right)*3]=rgb*(right-left)
    return pixels

frames=[]
for i in range(DURATION*2+1):
    t=min(i/2,DURATION-.05); m=pose(t); _,positions,sizes=scene(t); detections=[]
    for k,p in positions.items():
        if k=='keys' and 14<=t<20: detections.append({'entityId':k,'status':'not_seen','bbox':None,'semantics':{'provider':'synthetic_fixture','description':'被书本遮挡；保留最后观察位置'}}); continue
        sx,sy,sz=sizes[k]
        ps=[project([p[0]+dx*sx/2,p[1]+dy*sy/2,p[2]+dz*sz/2],m) for dx in [-1,1] for dy in [-1,1] for dz in [-1,1]]
        xs=[q[0]/W for q in ps]; ys=[(q[1]+(W-H)/2)/W for q in ps]
        bbox=[max(.001,min(xs)),max(.001,min(ys)),min(.999,max(xs)),min(.999,max(ys))]
        detections.append({'entityId':k,'status':'seen','bbox':bbox,'depthM':project(p,m)[2],'uncertaintyM':.03,'semantics':{'provider':'synthetic_fixture','description':'合成桌面录像中的道具','geometrySource':'known_synthetic_scene'}})
    frames.append({'time':t,'pose':{'mapId':'demo-room','trackingState':'tracking','worldFromCamera':[round(n,9) for row in m for n in row]},'detections':detections})

rng=random.Random(42); cloud=[]
for vertices,color in scene(0)[0]:
    a,b,c,d=vertices
    for _ in range(70):
        u,v=rng.random(),rng.random(); p=add(a,add(mul(sub(b,a),u),mul(sub(d,a),v)))
        hexcolor=color if isinstance(color,str) else '#'+''.join(f'{n:02x}' for n in color)
        cloud.append([*[round(n,4) for n in p],hexcolor])
manifest={'synthetic':True,'source':'procedurally generated first-person fixture; no real camera, AI detection or SLAM','duration':DURATION,'intrinsics':{'width':518,'height':518,'fx':F/W*518,'fy':F/W*518,'cx':259,'cy':259},'frames':frames,'points':cloud}
(OUT/'demo-manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}','-i','-','-frames:v','1',str(OUT/'demo-poster.jpg')],input=render(0),check=True)
proc=subprocess.Popen(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','rgb24','-video_size',f'{W}x{H}','-framerate',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',str(OUT/'demo-first-person.mp4')],stdin=subprocess.PIPE)
for i in range(DURATION*FPS): proc.stdin.write(render(i/FPS))
proc.stdin.close()
if proc.wait()!=0: raise RuntimeError('ffmpeg failed')
print(f'Synthetic fixture generated: {len(frames)} annotated frames, {len(cloud)} points, {DURATION}s video.')
