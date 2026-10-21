#import <Cocoa/Cocoa.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include "embedded_icon.h"

// On macOS the splash is a helper the app spawns, never the bundle's entry
// point: the Electron runtime is the product (it owns the windows, the menu bar
// item, capture permissions and the folder name macOS shows), so the splash
// renders the placeholder window, hands the app its socket, and exits.
static int handoff_socket = -1;
static const char *HELPER_ARGUMENT = "--codeinoven-native-splash-helper";
static NSWindow *placeholder_window = nil;
static char handoff_path[sizeof(((struct sockaddr_un *)0)->sun_path)] = {0};

@interface PlaceholderView : NSView
@property(nonatomic, strong) NSImage *icon;
@end

@implementation PlaceholderView
- (BOOL)isOpaque {
  return YES;
}

- (void)drawRect:(NSRect)dirtyRect {
  (void)dirtyRect;
  [[NSColor colorWithRed:11.0 / 255.0
                   green:11.0 / 255.0
                    blue:13.0 / 255.0
                   alpha:1.0] setFill];
  NSRectFill(self.bounds);
  if (self.icon != nil) {
    const NSRect iconRect = self.bounds;
    [self.icon drawInRect:iconRect
                 fromRect:NSZeroRect
                operation:NSCompositingOperationSourceOver
                 fraction:1.0
           respectFlipped:YES
                    hints:@{NSImageHintInterpolation : @(NSImageInterpolationHigh)}];
  }
}
@end

static void stop_helper(int signal_number) {
  (void)signal_number;
  if (handoff_socket >= 0) close(handoff_socket);
  if (handoff_path[0] != '\0') unlink(handoff_path);
  _exit(0);
}

static BOOL create_handoff_socket(NSString **endpoint) {
  NSString *temporary = NSTemporaryDirectory();
  NSString *templatePath = [temporary stringByAppendingPathComponent:@"codeinoven-splash-XXXXXX"];
  if ([templatePath lengthOfBytesUsingEncoding:NSUTF8StringEncoding] >= sizeof(handoff_path)) {
    templatePath = @"/tmp/codeinoven-splash-XXXXXX";
  }
  strncpy(handoff_path, templatePath.fileSystemRepresentation, sizeof(handoff_path) - 1);
  int temporaryFile = mkstemp(handoff_path);
  if (temporaryFile < 0) return NO;
  close(temporaryFile);
  unlink(handoff_path);

  handoff_socket = socket(AF_UNIX, SOCK_STREAM, 0);
  if (handoff_socket < 0) return NO;
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, handoff_path, sizeof(address.sun_path) - 1);
  if (bind(handoff_socket, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(handoff_path, S_IRUSR | S_IWUSR) != 0 || listen(handoff_socket, 1) != 0) {
    close(handoff_socket);
    handoff_socket = -1;
    unlink(handoff_path);
    return NO;
  }
  *endpoint = [NSString stringWithUTF8String:handoff_path];
  return YES;
}

static void finish_helper(void) {
  if (handoff_socket >= 0) {
    shutdown(handoff_socket, SHUT_RDWR);
    close(handoff_socket);
  }
  handoff_socket = -1;
  unlink(handoff_path);
  dispatch_async(dispatch_get_main_queue(), ^{
    [placeholder_window orderOut:nil];
    [NSApplication.sharedApplication terminate:nil];
  });
}

static void wait_for_handoff(void) {
  int client = accept(handoff_socket, NULL, NULL);
  char message[16] = {0};
  const ssize_t count = client >= 0 ? read(client, message, sizeof(message) - 1) : -1;
  if (client >= 0) close(client);
  if (count > 0 && strncmp(message, "ready", 5) == 0) finish_helper();
}

static int run_helper(int endpoint_pipe) {
  signal(SIGTERM, stop_helper);
  signal(SIGINT, stop_helper);
  NSApplication *application = NSApplication.sharedApplication;
  [application setActivationPolicy:NSApplicationActivationPolicyAccessory];

  const NSRect frame = NSMakeRect(0.0, 0.0, 420.0, 320.0);
  placeholder_window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:NSWindowStyleMaskBorderless
                  backing:NSBackingStoreBuffered
                    defer:NO];
  placeholder_window.backgroundColor = [NSColor colorWithRed:11.0 / 255.0
                                                       green:11.0 / 255.0
                                                        blue:13.0 / 255.0
                                                       alpha:1.0];
  placeholder_window.opaque = YES;
  placeholder_window.hasShadow = YES;
  placeholder_window.level = NSFloatingWindowLevel;
  placeholder_window.movable = NO;
  placeholder_window.releasedWhenClosed = NO;

  PlaceholderView *view = [[PlaceholderView alloc] initWithFrame:frame];
  placeholder_window.contentView = view;
  NSScreen *primaryScreen = NSScreen.screens.firstObject;
  if (primaryScreen != nil) {
    const NSRect screenFrame = primaryScreen.frame;
    [placeholder_window setFrameOrigin:NSMakePoint(
                                             NSMinX(screenFrame) +
                                                 (NSWidth(screenFrame) - NSWidth(frame)) / 2.0,
                                             NSMinY(screenFrame) +
                                                 (NSHeight(screenFrame) - NSHeight(frame)) / 2.0)];
  }
  [placeholder_window orderFrontRegardless];
  [placeholder_window displayIfNeeded];

  NSData *iconData = [NSData dataWithBytesNoCopy:(void *)CODEINOVEN_ICON_PNG
                                          length:CODEINOVEN_ICON_PNG_SIZE
                                    freeWhenDone:NO];
  view.icon = [[NSImage alloc] initWithData:iconData];
  [view setNeedsDisplay:YES];
  [placeholder_window displayIfNeeded];

  NSString *endpoint = nil;
  if (!create_handoff_socket(&endpoint)) return 70;
  const char *endpointBytes = endpoint.fileSystemRepresentation;
  const size_t endpointSize = strlen(endpointBytes) + 1;
  if (write(endpoint_pipe, endpointBytes, endpointSize) != (ssize_t)endpointSize) return 71;
  close(endpoint_pipe);

  [NSThread detachNewThreadWithBlock:^{ wait_for_handoff(); }];
  [NSTimer scheduledTimerWithTimeInterval:15.0
                                  repeats:NO
                                    block:^(NSTimer *timer) {
                                      (void)timer;
                                      finish_helper();
                                    }];
  [application run];
  return 0;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 2 || strcmp(argv[1], HELPER_ARGUMENT) != 0) {
      // The app owns the bundle; a bare invocation is a packaging mistake and
      // must not silently start a second Electron instance.
      fprintf(stderr, "usage: %s %s <endpoint-fd>\n", argv[0], HELPER_ARGUMENT);
      return 64;
    }
    // The subscribing app hands the endpoint pipe as a file descriptor and reads
    // the socket path from it, so the handoff never depends on a shared path.
    return run_helper(argc >= 3 ? atoi(argv[2]) : STDOUT_FILENO);
  }
}
