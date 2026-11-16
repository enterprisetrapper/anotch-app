#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#include <node_api.h>
#include <cmath>
#include <cstring>

static char EffectKey;

struct Shape {
  CGFloat width, height, top, bottom;
};

static bool ReadNumber(napi_env env, napi_value value, double& number) {
  return napi_get_value_double(env, value, &number) == napi_ok && std::isfinite(number) && number >= 0;
}

static bool ReadShape(napi_env env, napi_value value, Shape& shape) {
  uint32_t count = 0;
  if (napi_get_array_length(env, value, &count) != napi_ok || count != 4) return false;
  double geometry[4];
  for (uint32_t i = 0; i < count; i++) {
    napi_value entry;
    if (napi_get_element(env, value, i, &entry) != napi_ok || !ReadNumber(env, entry, geometry[i])) return false;
  }
  shape = { geometry[0], geometry[1], geometry[2], geometry[3] };
  return true;
}

static CGPathRef CreateOutline(Shape shape, CGRect bounds, CGFloat shoulder) {
  const CGFloat left = CGRectGetMidX(bounds) - shape.width / 2, right = left + shape.width;
  const CGAffineTransform flip = CGAffineTransformMake(1, 0, 0, -1, 0, CGRectGetHeight(bounds));
  CGMutablePathRef path = CGPathCreateMutable();
  CGPathMoveToPoint(path, &flip, left - shoulder, 0);
  CGPathAddLineToPoint(path, &flip, right + shoulder, 0);
  CGPathAddQuadCurveToPoint(path, &flip, right, 0, right, shape.top);
  CGPathAddLineToPoint(path, &flip, right, shape.height - shape.bottom);
  CGPathAddQuadCurveToPoint(path, &flip, right, shape.height, right - shape.bottom, shape.height);
  CGPathAddLineToPoint(path, &flip, left + shape.bottom, shape.height);
  CGPathAddQuadCurveToPoint(path, &flip, left, shape.height, left, shape.height - shape.bottom);
  CGPathAddLineToPoint(path, &flip, left, shape.top);
  CGPathAddQuadCurveToPoint(path, &flip, left, 0, left - shoulder, 0);
  CGPathCloseSubpath(path);
  return path;
}

static napi_value Draw(napi_env env, napi_callback_info info) {
  size_t count = 8;
  napi_value args[8];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  napi_value result;
  napi_get_boolean(env, false, &result);
  void* data = nullptr;
  size_t size = 0;
  if (count != 8 || ![NSThread isMainThread] ||
      napi_get_buffer_info(env, args[0], &data, &size) != napi_ok || size != sizeof(void*)) return result;
  double band, shoulder, duration, elapsed, ease;
  Shape to{}, from{};
  if (!ReadNumber(env, args[1], band) || !ReadNumber(env, args[2], shoulder) ||
      !ReadShape(env, args[3], to) || !ReadNumber(env, args[5], duration) ||
      !ReadNumber(env, args[6], elapsed) || !ReadNumber(env, args[7], ease) || ease > 1) return result;
  const bool animating = elapsed < duration;
  if (animating && !ReadShape(env, args[4], from)) return result;
  void* pointer = nullptr;
  std::memcpy(&pointer, data, size);
  NSView* content = (__bridge NSView*)pointer;
  if (!content || !content.window) return result;
  content.window.animationBehavior = band > 0 ? NSWindowAnimationBehaviorNone : NSWindowAnimationBehaviorDefault;

  NSVisualEffectView* effect = objc_getAssociatedObject(content, &EffectKey);
  if (to.height == 0 || band == 0) {
    [effect.layer.mask removeAnimationForKey:@"notchOutline"];
    effect.hidden = YES;
    napi_get_boolean(env, true, &result);
    return result;
  }
  if (!effect) {
    // Attach the glass at the idle notch so the first click can animate an existing layer.
    effect = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
    effect.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    effect.appearance = [NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];
    effect.material = NSVisualEffectMaterialHUDWindow;
    effect.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    effect.state = NSVisualEffectStateActive;
    effect.wantsLayer = YES;
    effect.layer.mask = [CAShapeLayer layer];
    [content addSubview:effect positioned:NSWindowBelow relativeTo:nil];
    objc_setAssociatedObject(content, &EffectKey, effect, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  }

  CAShapeLayer* mask = (CAShapeLayer*)effect.layer.mask;
  const CGRect bounds = effect.bounds;
  CGPathRef path = CreateOutline(to, bounds, shoulder);
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  [mask removeAnimationForKey:@"notchOutline"];
  mask.frame = bounds;
  mask.path = path;
  if (animating) {
    CGPathRef origin = CreateOutline(from, bounds, shoulder);
    CABasicAnimation* animation = [CABasicAnimation animationWithKeyPath:@"path"];
    animation.fromValue = (__bridge id)origin;
    animation.toValue = (__bridge id)path;
    animation.duration = duration / 1000;
    animation.beginTime = [mask convertTime:CACurrentMediaTime() fromLayer:nil] - elapsed / 1000;
    animation.timingFunction = [CAMediaTimingFunction functionWithControlPoints:1.0f / 3.0f :ease :2.0f / 3.0f :1.0f];
    [mask addAnimation:animation forKey:@"notchOutline"];
    CGPathRelease(origin);
  }
  effect.hidden = NO;
  [CATransaction commit];
  CGPathRelease(path);
  napi_get_boolean(env, true, &result);
  return result;
}

NAPI_MODULE_INIT() {
  napi_value function;
  napi_create_function(env, "draw", NAPI_AUTO_LENGTH, Draw, nullptr, &function);
  return function;
}
