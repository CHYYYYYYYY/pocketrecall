# Real desk sample

Derived from **TUM RGB-D Benchmark, rgbd_dataset_freiburg1_desk**, by Jürgen Sturm, Nikolas Engelhard, Felix Endres, Wolfram Burgard and Daniel Cremers. Source: [TUM RGB-D Benchmark](https://cvg.cit.tum.de/data/datasets/rgbd-dataset), [download](https://cvg.cit.tum.de/rgbd/dataset/freiburg1/rgbd_dataset_freiburg1_desk.tgz). Data license: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as stated on the source website. No endorsement is implied.

Reference: *A Benchmark for the Evaluation of RGB-D SLAM Systems*, IROS 2012.

Changes: a short excerpt is resampled to 15 fps and encoded as MP4; eight RGB frames are resized and letterboxed; registered depth is resampled to 130×130; capture poses are expressed in one coordinate frame anchored at the first camera. This is real handheld Kinect footage, not a glasses recording. Zero depth means unavailable. Following the dataset's recommendation for pre-registered depth, projection uses ROS default intrinsics (525/525/319.5/239.5) adjusted for resizing. The 16-bit depth conversion is /5000; no additional scale correction is applied. Nearest timestamp matching is limited to 25 ms. Small registration/calibration and bounding-box-center errors remain.

Object boxes and visual descriptions in `manifest.json` are actual recorded Gemini outputs. Model and timing metadata are attached to each capture. Sensor geometry is reference input, not model-generated 3D or evidence that our system estimates camera tracking. Replaying the sample executes the same memory, agent and guidance code; live recognition explicitly calls Gemini again.

To regenerate: download the archive, run `python scripts/prepare-review.py ARCHIVE` (Pillow, NumPy and ffmpeg), then `node scripts/record-review-vision.mjs` with server credentials in ignored `.env.local`. Keep this notice with redistributed derivatives.

`voice-query.wav` is generated English test speech (macOS system voice): “Where did you last see the keyboard?” It contains no user microphone recording and is used only by the optional live voice rehearsal.
