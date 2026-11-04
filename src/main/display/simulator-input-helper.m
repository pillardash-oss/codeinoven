/*
 * cio-display-input: post real input at a Device Hub window.
 *
 * A simulator is an ordinary application window, so working it means posting the
 * same events a hand would: a click where the finger went, a drag for a swipe, a
 * keystroke for a key. macOS gates that behind the accessibility grant, which the
 * app holds, and this helper inherits it because it is launched by the app.
 *
 * The helper is deliberately dumb. It lists windows, and it posts events at the
 * coordinates it is given. Where the device's screen sits inside a window is a
 * measurement, and measurements belong to the caller, which can compare against
 * the frame it already mirrors.
 *
 * The device's screen is not found by guesswork: the simulator bridges its own
 * accessibility tree to the Mac, so `frame` reports the device content group's
 * exact rectangle on the desktop, and `axpress` activates one of the window's own
 * controls (Home, Lock, Rotate) the way an assistive technology would.
 *
 * Output is line-based so a caller can read it without a parser library:
 *   list    -> one JSON object per Device Hub window, one per line
 *   click   <x> <y>                screen points
 *   press   <x> <y> <ms>           a held click
 *   drag    <x1> <y1> <x2> <y2> <ms>
 *   type    <text>                 unicode text, one key event per character
 *   key     <virtualKey>           a real keyboard key by CGKeyCode
 *   volume  <up|down>              one step of this Mac's output volume
 *   activate <pid>                 bring a window's application forward
 *   frame   <pid>                  the device screen's rectangle, in screen points
 *   ax      <pid>                  that rectangle, then every element inside it
 *   axpress <pid> <title|identifier> press one of the window's own controls
 */
#include <AppKit/AppKit.h>
#include <CoreAudio/CoreAudio.h>
#include <ApplicationServices/ApplicationServices.h>
#include <Foundation/Foundation.h>

static CGPoint pointFrom(double x, double y) { return CGPointMake(x, y); }

static void cioPost(CGEventType type, CGPoint point) {
  CGEventRef event = CGEventCreateMouseEvent(NULL, type, point, kCGMouseButtonLeft);
  if (!event) return;
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static CGPoint cioPointer(void) {
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  return point;
}

static void cioMove(CGPoint point) { cioPost(kCGEventMouseMoved, point); }

static void cioClickAt(CGPoint point, int holdMs) {
  cioMove(point);
  usleep(15000);
  cioPost(kCGEventLeftMouseDown, point);
  usleep((useconds_t)holdMs * 1000);
  cioPost(kCGEventLeftMouseUp, point);
}

static void cioDrag(CGPoint from, CGPoint to, int durationMs) {
  cioMove(from);
  usleep(15000);
  cioPost(kCGEventLeftMouseDown, from);
  const int steps = durationMs < 120 ? 6 : 18;
  for (int step = 1; step <= steps; step += 1) {
    double ratio = (double)step / (double)steps;
    CGPoint at = CGPointMake(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio);
    cioPost(kCGEventLeftMouseDragged, at);
    usleep((useconds_t)((durationMs * 1000) / steps));
  }
  cioPost(kCGEventLeftMouseUp, to);
}

static void cioKeyEvent(CGKeyCode key, BOOL down, CGEventFlags flags) {
  CGEventRef event = CGEventCreateKeyboardEvent(NULL, key, down);
  if (!event) return;
  if (flags != 0) CGEventSetFlags(event, flags);
  CGEventPost(kCGHIDEventTap, event);
  CFRelease(event);
}

static void cioHotkey(CGKeyCode key, CGEventFlags flags);

static void cioType(NSString *text) {
  // A simulator reads key codes, not the characters attached to them, so typing a
  // word means handing it the pasteboard: one command-V carries any text, in any
  // script, where per-character key codes would only carry the Latin alphabet.
  NSPasteboard *board = [NSPasteboard generalPasteboard];
  // The person's own clipboard is put back when the word has landed, so typing in
  // a device never costs them what they had copied. The items are copied by type
  // because a pasteboard item belongs to the pasteboard it was read from.
  NSMutableArray<NSPasteboardItem *> *saved = [NSMutableArray array];
  for (NSPasteboardItem *item in board.pasteboardItems) {
    NSPasteboardItem *copy = [[NSPasteboardItem alloc] init];
    for (NSPasteboardType type in item.types) {
      NSData *data = [item dataForType:type];
      if (data) [copy setData:data forType:type];
    }
    [saved addObject:copy];
  }
  [board clearContents];
  [board setString:text forType:NSPasteboardTypeString];
  usleep(20000);
  cioHotkey((CGKeyCode)9, kCGEventFlagMaskCommand);
  usleep(80000);
  if (saved.count > 0) {
    [board clearContents];
    [board writeObjects:saved];
  } else {
    [board clearContents];
  }
}

static void cioHotkey(CGKeyCode key, CGEventFlags flags) {
  const struct {
    CGEventFlags flag;
    CGKeyCode key;
  } modifiers[] = {{kCGEventFlagMaskCommand, 55},
                   {kCGEventFlagMaskShift, 56},
                   {kCGEventFlagMaskAlternate, 58},
                   {kCGEventFlagMaskControl, 59}};
  // A chord needs the modifier keys held as real key state: a flag on the letter
  // alone reaches applications that read events, but not ones that read the
  // keyboard, which is what a simulator does.
  size_t held = 0;
  for (size_t index = 0; index < sizeof(modifiers) / sizeof(modifiers[0]); index += 1) {
    if ((flags & modifiers[index].flag) == 0) continue;
    cioKeyEvent(modifiers[index].key, YES, flags);
    held += 1;
    usleep(12000);
  }
  cioKeyEvent(key, YES, flags);
  usleep(40000);
  cioKeyEvent(key, NO, flags);
  usleep(12000);
  for (size_t index = sizeof(modifiers) / sizeof(modifiers[0]); index > 0; index -= 1) {
    if ((flags & modifiers[index - 1].flag) == 0) continue;
    cioKeyEvent(modifiers[index - 1].key, NO, 0);
    usleep(12000);
  }
  (void)held;
}

/*
 * A simulator has no volume of its own: its audio leaves through this Mac, so the
 * output volume is the device's volume. One step is a sixteenth, which is the
 * step a hardware volume key takes.
 */
static int changeVolume(int direction) {
  AudioObjectPropertyAddress output = {kAudioHardwarePropertyDefaultOutputDevice,
                                      kAudioObjectPropertyScopeGlobal,
                                      kAudioObjectPropertyElementMain};
  AudioDeviceID device = 0;
  UInt32 size = sizeof(device);
  if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &output, 0, NULL, &size, &device) !=
          noErr ||
      device == 0)
    return 1;
  AudioObjectPropertyAddress level = {kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyScopeOutput,
                                     kAudioObjectPropertyElementMain};
  const AudioObjectPropertyElement channels[] = {kAudioObjectPropertyElementMain, 1, 2};
  for (size_t index = 0; index < sizeof(channels) / sizeof(channels[0]); index += 1) {
    level.mElement = channels[index];
    if (!AudioObjectHasProperty(device, &level)) continue;
    Float32 current = 0;
    size = sizeof(current);
    if (AudioObjectGetPropertyData(device, &level, 0, NULL, &size, &current) != noErr) continue;
    Float32 next = current + (direction > 0 ? 0.0625f : -0.0625f);
    if (next < 0) next = 0;
    if (next > 1) next = 1;
    if (AudioObjectSetPropertyData(device, &level, 0, NULL, sizeof(next), &next) != noErr) continue;
    printf("volume\t%.4f\n", next);
    return 0;
  }
  return 1;
}

static void listWindows(void) {
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
  if (!windows) return;
  for (NSDictionary *window in (__bridge NSArray *)windows) {
    NSString *owner = window[(id)kCGWindowOwnerName];
    if (owner == nil) continue;
    BOOL relevant = [owner isEqualToString:@"Device Hub"] || [owner isEqualToString:@"Simulator"] ||
                    [owner isEqualToString:@"Simulator (Beta)"];
    if (!relevant) continue;
    CGRect bounds = CGRectZero;
    CGRectMakeWithDictionaryRepresentation(
        (__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds);
    if (bounds.size.width < 200 || bounds.size.height < 200) continue;
    NSDictionary *entry = @{
      @"id" : window[(id)kCGWindowNumber],
      @"pid" : window[(id)kCGWindowOwnerPID],
      @"name" : window[(id)kCGWindowName] ?: @"",
      @"x" : @(bounds.origin.x),
      @"y" : @(bounds.origin.y),
      @"w" : @(bounds.size.width),
      @"h" : @(bounds.size.height),
      @"front" : @([NSWorkspace sharedWorkspace].frontmostApplication.processIdentifier ==
                   [window[(id)kCGWindowOwnerPID] intValue])
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:entry options:0 error:NULL];
    if (!json) continue;
    NSString *line = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    printf("%s\n", line.UTF8String);
  }
  CFRelease(windows);
}

static NSString *axString(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess || !value) return @"";
  NSString *text = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) text = [(__bridge NSString *)value copy];
  CFRelease(value);
  return text ?: @"";
}

static BOOL axFrame(AXUIElementRef element, CGRect *out) {
  CFTypeRef position = NULL;
  CFTypeRef size = NULL;
  BOOL ok = NO;
  if (AXUIElementCopyAttributeValue(element, kAXPositionAttribute, &position) == kAXErrorSuccess &&
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute, &size) == kAXErrorSuccess &&
      position && size) {
    CGPoint point = CGPointZero;
    CGSize extent = CGSizeZero;
    AXValueGetValue((AXValueRef)position, kAXValueCGPointType, &point);
    AXValueGetValue((AXValueRef)size, kAXValueCGSizeType, &extent);
    *out = CGRectMake(point.x, point.y, extent.width, extent.height);
    ok = YES;
  }
  if (position) CFRelease(position);
  if (size) CFRelease(size);
  return ok;
}

/** The node the device paints into: the only group that carries its own content. */
static AXUIElementRef findContentGroup(AXUIElementRef element, int depth) {
  if (depth > 12) return NULL;
  // The bridge marks the device's screen with its own subrole, not an identifier.
  NSString *identifier = axString(element, CFSTR("AXIdentifier"));
  NSString *subrole = axString(element, kAXSubroleAttribute);
  if ([identifier isEqualToString:@"iOSContentGroup"] || [subrole isEqualToString:@"iOSContentGroup"])
    return (AXUIElementRef)CFRetain(element);
  CFTypeRef children = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) != kAXErrorSuccess ||
      !children)
    return NULL;
  AXUIElementRef found = NULL;
  for (id child in (__bridge NSArray *)children) {
    found = findContentGroup((__bridge AXUIElementRef)child, depth + 1);
    if (found) break;
  }
  CFRelease(children);
  return found;
}

static AXUIElementRef findElement(AXUIElementRef element, NSString *wanted, int depth) {
  if (depth > 16) return NULL;
  NSString *identifier = axString(element, CFSTR("AXIdentifier"));
  NSString *description = axString(element, kAXDescriptionAttribute);
  NSString *title = axString(element, kAXTitleAttribute);
  if ([identifier isEqualToString:wanted] || [description isEqualToString:wanted] ||
      [title isEqualToString:wanted])
    return (AXUIElementRef)CFRetain(element);
  CFTypeRef children = NULL;
  if (AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &children) != kAXErrorSuccess ||
      !children)
    return NULL;
  AXUIElementRef found = NULL;
  for (id child in (__bridge NSArray *)children) {
    found = findElement((__bridge AXUIElementRef)child, wanted, depth + 1);
    if (found) break;
  }
  CFRelease(children);
  return found;
}

static void describeElements(AXUIElementRef group) {
  CFTypeRef children = NULL;
  if (AXUIElementCopyAttributeValue(group, kAXChildrenAttribute, &children) != kAXErrorSuccess ||
      !children)
    return;
  for (id child in (__bridge NSArray *)children) {
    AXUIElementRef element = (__bridge AXUIElementRef)child;
    NSString *role = axString(element, kAXRoleAttribute);
    NSString *identifier = axString(element, CFSTR("AXIdentifier"));
    NSString *description = axString(element, kAXDescriptionAttribute);
    CGRect frame = CGRectZero;
    if (!axFrame(element, &frame)) continue;
    printf("element\t%s\t%s\t%s\t%.1f\t%.1f\t%.1f\t%.1f\n", role.UTF8String,
           identifier.UTF8String, description.UTF8String, frame.origin.x, frame.origin.y,
           frame.size.width, frame.size.height);
  }
  CFRelease(children);
}

static int dumpAccessibility(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return 1;
  AXUIElementRef group = findContentGroup(app, 0);
  CFRelease(app);
  if (!group) return 1;
  CGRect frame = CGRectZero;
  if (!axFrame(group, &frame)) {
    CFRelease(group);
    return 1;
  }
  printf("group\t%.1f\t%.1f\t%.1f\t%.1f\n", frame.origin.x, frame.origin.y, frame.size.width,
         frame.size.height);
  describeElements(group);
  CFRelease(group);
  return 0;
}

static int frameForWindow(pid_t pid) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return 1;
  AXUIElementRef group = findContentGroup(app, 0);
  CFRelease(app);
  if (!group) return 1;
  CGRect frame = CGRectZero;
  BOOL measured = axFrame(group, &frame);
  CFRelease(group);
  if (!measured) return 1;
  printf("group\t%.1f\t%.1f\t%.1f\t%.1f\n", frame.origin.x, frame.origin.y, frame.size.width,
         frame.size.height);
  return 0;
}

static int pressElement(pid_t pid, NSString *wanted) {
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  if (!app) return 1;
  AXUIElementRef element = findElement(app, wanted, 0);
  CFRelease(app);
  if (!element) return 1;
  AXError error = AXUIElementPerformAction(element, kAXPressAction);
  if (error != kAXErrorSuccess) {
    CGRect frame = CGRectZero;
    BOOL hasFrame = axFrame(element, &frame);
    fprintf(stderr, "press failed for %s: AXError %d, frame %d %.0f,%.0f %.0fx%.0f\n",
            wanted.UTF8String, (int)error, hasFrame, frame.origin.x, frame.origin.y,
            frame.size.width, frame.size.height);
    if (hasFrame) cioClickAt(CGPointMake(CGRectGetMidX(frame), CGRectGetMidY(frame)), 40);
  }
  CFRelease(element);
  return error == kAXErrorSuccess ? 0 : 1;
}

/** One sixteenth of the output volume, which is what a hardware volume key takes. */
static int cioVolume(NSString *direction) {
  int delta = [direction isEqualToString:@"up"] ? 6 : -6;
  NSString *source = [NSString
      stringWithFormat:@"set volume output volume ((output volume of (get volume settings)) + %d)", delta];
  NSAppleScript *script = [[NSAppleScript alloc] initWithSource:source];
  NSDictionary *error = nil;
  [script executeAndReturnError:&error];
  return error == nil ? 0 : 1;
}

int main(int argc, char **argv) {
  @autoreleasepool {
    setbuf(stdout, NULL);
    if (argc < 2) {
      fprintf(stderr, "usage: cio-display-input list|click|press|drag|type|key|volume|activate|frame|ax|axpress ...\n");
      return 2;
    }
    NSString *command = [NSString stringWithUTF8String:argv[1]];
    if ([command isEqualToString:@"list"]) {
      listWindows();
      return 0;
    }
    if ([command isEqualToString:@"click"] && argc >= 4) {
      CGPoint home = cioPointer();
      cioClickAt(pointFrom(atof(argv[2]), atof(argv[3])), 40);
      // The person's own pointer goes back where it was: the panel works a
      // device, it does not take the mouse away from whatever they were doing.
      usleep(30000);
      CGWarpMouseCursorPosition(home);
      return 0;
    }
    if ([command isEqualToString:@"press"] && argc >= 5) {
      CGPoint home = cioPointer();
      cioClickAt(pointFrom(atof(argv[2]), atof(argv[3])), atoi(argv[4]));
      usleep(30000);
      CGWarpMouseCursorPosition(home);
      return 0;
    }
    if ([command isEqualToString:@"drag"] && argc >= 7) {
      CGPoint home = cioPointer();
      cioDrag(pointFrom(atof(argv[2]), atof(argv[3])), pointFrom(atof(argv[4]), atof(argv[5])),
                 atoi(argv[6]));
      usleep(30000);
      CGWarpMouseCursorPosition(home);
      return 0;
    }
    if ([command isEqualToString:@"type"] && argc >= 3) {
      cioType([NSString stringWithUTF8String:argv[2]]);
      return 0;
    }
    if ([command isEqualToString:@"key"] && argc >= 3) {
      CGKeyCode key = (CGKeyCode)atoi(argv[2]);
      cioKeyEvent(key, YES, 0);
      usleep(20000);
      cioKeyEvent(key, NO, 0);
      return 0;
    }
    if ([command isEqualToString:@"volume"] && argc >= 3) {
      return changeVolume([@"up" isEqualToString:[NSString stringWithUTF8String:argv[2]]] ? 1 : -1);
    }
    if ([command isEqualToString:@"ax"] && argc >= 3) {
      return dumpAccessibility((pid_t)atoi(argv[2]));
    }
    if ([command isEqualToString:@"frame"] && argc >= 3) {
      return frameForWindow((pid_t)atoi(argv[2]));
    }
    if ([command isEqualToString:@"axpress"] && argc >= 4) {
      return pressElement((pid_t)atoi(argv[2]), [NSString stringWithUTF8String:argv[3]]);
    }
    if ([command isEqualToString:@"activate"] && argc >= 3) {
      pid_t pid = (pid_t)atoi(argv[2]);
      NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
      // Zero options: macOS 14 dropped the old ignoring-other-apps flag, and a
      // plain activation is what brings the window forward now.
      [app activateWithOptions:0];
      return 0;
    }
    fprintf(stderr, "unknown command\n");
    return 2;
  }
}
