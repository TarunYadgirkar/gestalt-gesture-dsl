// The demo compiles the exact same YAML the tests and eval harness use — bundled as
// raw text so there is no second, drifting copy of the gesture definitions.
import pinch from '../../gestures/pinch.yaml?raw';
import pinchDrag from '../../gestures/pinch-drag.yaml?raw';
import twoHandScale from '../../gestures/two-hand-scale.yaml?raw';
import twoHandRotate from '../../gestures/two-hand-rotate.yaml?raw';
import dwellSelect from '../../gestures/dwell-select.yaml?raw';
import palmPush from '../../gestures/palm-push.yaml?raw';
import swipe from '../../gestures/swipe.yaml?raw';

export const GESTURE_SOURCES: Record<string, string> = {
  pinch,
  'pinch-drag': pinchDrag,
  'two-hand-scale': twoHandScale,
  'two-hand-rotate': twoHandRotate,
  'dwell-select': dwellSelect,
  'palm-push': palmPush,
  swipe,
};
