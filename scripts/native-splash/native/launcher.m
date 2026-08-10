#import <Cocoa/Cocoa.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>
#include "embedded_icon.h"

extern char **environ;

static const char *HELPER_ARGUMENT = "--codeinoven-native-splash-helper";
static NSWindow *placeholder_window = nil;
static int handoff_socket = -1;
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
  [[NSColor blackColor] setFill];
  NSRectFill(self.bounds);
  if (self.icon == nil) return;
  const NSRect iconRect = NSMakeRect(
      (NSWidth(self.bounds) - 200.0) / 2.0,
      (NSHeight(self.bounds) - 200.0) / 2.0,
      200.0,
      200.0);
  [self.icon drawInRect:iconRect
               fromRect:NSZeroRect
              operation:NSCompositingOperationSourceOver
               fraction:1.0
         respectFlipped:YES
                  hints:@{NSImageHintInterpolation : @(NSImageInterpolationHigh)}];
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
  placeholder_window.backgroundColor = NSColor.blackColor;
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

static const char *current_executable(void) {
  return NSBundle.mainBundle.executablePath.fileSystemRepresentation;
}

static NSString *electron_path(void) {
  return [[NSBundle.mainBundle.executablePath stringByDeletingLastPathComponent]
      stringByAppendingPathComponent:@"CodeInOven-electron"];
}

static int launch_electron(int argc, const char *argv[]) {
  int readyPipe[2] = {-1, -1};
  if (pipe(readyPipe) != 0) return 72;
  fcntl(readyPipe[0], F_SETFD, FD_CLOEXEC);

  char pipeArgument[24] = {0};
  snprintf(pipeArgument, sizeof(pipeArgument), "%d", readyPipe[1]);
  char *helperArguments[] = {
      (char *)current_executable(), (char *)HELPER_ARGUMENT, pipeArgument, NULL};
  pid_t helperPid = -1;
  const int spawnResult =
      posix_spawn(&helperPid, current_executable(), NULL, NULL, helperArguments, environ);
  close(readyPipe[1]);

  char endpoint[sizeof(handoff_path)] = {0};
  if (spawnResult == 0) {
    struct pollfd descriptor = {.fd = readyPipe[0], .events = POLLIN, .revents = 0};
    if (poll(&descriptor, 1, 2500) > 0) {
      const ssize_t count = read(readyPipe[0], endpoint, sizeof(endpoint) - 1);
      if (count > 0) endpoint[count] = '\0';
    }
  }
  close(readyPipe[0]);
  if (endpoint[0] != '\0') {
    setenv("CODEINOVEN_NATIVE_SPLASH_ENDPOINT", endpoint, 1);
  } else if (helperPid > 0) {
    kill(helperPid, SIGTERM);
  }

  NSString *electronPath = electron_path();
  char **electronArguments = calloc((size_t)argc + 1, sizeof(char *));
  if (electronArguments == NULL) return 73;
  electronArguments[0] = (char *)electronPath.fileSystemRepresentation;
  for (int index = 1; index < argc; index += 1) electronArguments[index] = (char *)argv[index];
  execv(electronArguments[0], electronArguments);
  if (helperPid > 0) kill(helperPid, SIGTERM);
  free(electronArguments);
  return 74;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc == 3 && strcmp(argv[1], HELPER_ARGUMENT) == 0) {
      return run_helper(atoi(argv[2]));
    }
    return launch_electron(argc, argv);
  }
}
