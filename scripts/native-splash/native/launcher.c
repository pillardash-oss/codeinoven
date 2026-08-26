#include <gtk/gtk.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#include "embedded_icon.h"

static GtkWidget *placeholder_window = NULL;
static GdkPixbuf *icon_pixbuf = NULL;
static int handoff_socket = -1;
static char handoff_path[sizeof(((struct sockaddr_un *)0)->sun_path)] = {0};

static void draw_centered_text(cairo_t *context, const char *text, double baseline,
                               double font_size, double alpha, double width) {
  cairo_text_extents_t extents;
  cairo_select_font_face(context, "sans", CAIRO_FONT_SLANT_NORMAL, CAIRO_FONT_WEIGHT_NORMAL);
  cairo_set_font_size(context, font_size);
  cairo_text_extents(context, text, &extents);
  cairo_set_source_rgba(context, 0.97, 0.96, 0.95, alpha);
  cairo_move_to(context, (width - extents.width) / 2.0 - extents.x_bearing, baseline);
  cairo_show_text(context, text);
}

static gboolean draw_placeholder(GtkWidget *widget, cairo_t *context, gpointer data) {
  (void)data;
  GtkAllocation allocation;
  gtk_widget_get_allocation(widget, &allocation);
  cairo_set_source_rgb(context, 0.0, 0.0, 0.0);
  cairo_paint(context);
  if (icon_pixbuf != NULL) {
    const int x = (allocation.width - gdk_pixbuf_get_width(icon_pixbuf)) / 2;
    const int y = (allocation.height - gdk_pixbuf_get_height(icon_pixbuf)) / 2;
    gdk_cairo_set_source_pixbuf(context, icon_pixbuf, x, y);
    cairo_paint(context);
  }
  draw_centered_text(context, CODEINOVEN_VERSION, 280.0, 11.0, 0.72, allocation.width);
  draw_centered_text(context, "By", 295.0, 9.0, 0.48, allocation.width);
  draw_centered_text(context, CODEINOVEN_COMPANY, 309.0, 9.0, 0.48, allocation.width);
  return FALSE;
}

static gboolean finish_helper(gpointer data) {
  (void)data;
  if (handoff_socket >= 0) {
    shutdown(handoff_socket, SHUT_RDWR);
    close(handoff_socket);
  }
  handoff_socket = -1;
  unlink(handoff_path);
  if (placeholder_window != NULL) gtk_widget_hide(placeholder_window);
  gtk_main_quit();
  return G_SOURCE_REMOVE;
}

static int create_handoff_socket(void) {
  const char *temporary = getenv("TMPDIR");
  if (temporary == NULL || temporary[0] == '\0') temporary = "/tmp";
  if (snprintf(handoff_path, sizeof(handoff_path), "%s/codeinoven-splash-XXXXXX", temporary) >=
      (int)sizeof(handoff_path)) {
    strcpy(handoff_path, "/tmp/codeinoven-splash-XXXXXX");
  }
  int temporary_file = mkstemp(handoff_path);
  if (temporary_file < 0) return -1;
  close(temporary_file);
  unlink(handoff_path);

  handoff_socket = socket(AF_UNIX, SOCK_STREAM, 0);
  if (handoff_socket < 0) return -1;
  struct sockaddr_un address = {0};
  address.sun_family = AF_UNIX;
  strncpy(address.sun_path, handoff_path, sizeof(address.sun_path) - 1);
  if (bind(handoff_socket, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(handoff_path, S_IRUSR | S_IWUSR) != 0 || listen(handoff_socket, 1) != 0) {
    close(handoff_socket);
    handoff_socket = -1;
    unlink(handoff_path);
    return -1;
  }
  return 0;
}

static void *wait_for_handoff(void *unused) {
  (void)unused;
  int client = accept(handoff_socket, NULL, NULL);
  char message[16] = {0};
  const ssize_t count = client >= 0 ? read(client, message, sizeof(message) - 1) : -1;
  if (client >= 0) close(client);
  if (count > 0 && strncmp(message, "ready", 5) == 0) {
    g_idle_add(finish_helper, NULL);
  }
  return NULL;
}

static char *electron_path(void) {
  char executable[4096] = {0};
  const ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  if (length <= 0 || length >= (ssize_t)sizeof(executable)) return NULL;
  executable[length] = '\0';
  char *separator = strrchr(executable, '/');
  if (separator == NULL) return NULL;
  *separator = '\0';
  const size_t size = strlen(executable) + strlen("/codeinoven-electron") + 1;
  char *path = malloc(size);
  if (path != NULL) snprintf(path, size, "%s/codeinoven-electron", executable);
  return path;
}

static int run_helper(int argc, char **argv, int endpoint_pipe) {
  prctl(PR_SET_PDEATHSIG, SIGTERM);
  gtk_init(&argc, &argv);
  placeholder_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
  gtk_window_set_decorated(GTK_WINDOW(placeholder_window), FALSE);
  gtk_window_set_resizable(GTK_WINDOW(placeholder_window), FALSE);
  gtk_window_set_skip_taskbar_hint(GTK_WINDOW(placeholder_window), TRUE);
  gtk_window_set_keep_above(GTK_WINDOW(placeholder_window), TRUE);
  gtk_window_set_default_size(GTK_WINDOW(placeholder_window), 420, 320);
  GdkDisplay *display = gdk_display_get_default();
  GdkMonitor *primary_monitor =
      display != NULL ? gdk_display_get_primary_monitor(display) : NULL;
  if (primary_monitor != NULL) {
    GdkRectangle monitor_geometry = {0};
    gdk_monitor_get_geometry(primary_monitor, &monitor_geometry);
    gtk_window_move(
        GTK_WINDOW(placeholder_window),
        monitor_geometry.x + (monitor_geometry.width - 420) / 2,
        monitor_geometry.y + (monitor_geometry.height - 320) / 2);
  } else {
    gtk_window_set_position(GTK_WINDOW(placeholder_window), GTK_WIN_POS_CENTER_ALWAYS);
  }
  GtkWidget *drawing_area = gtk_drawing_area_new();
  gtk_container_add(GTK_CONTAINER(placeholder_window), drawing_area);
  g_signal_connect(drawing_area, "draw", G_CALLBACK(draw_placeholder), NULL);
  gtk_widget_show_all(placeholder_window);
  while (gtk_events_pending()) gtk_main_iteration();
  if (display != NULL) gdk_display_flush(display);

  GdkPixbufLoader *loader = gdk_pixbuf_loader_new_with_type("png", NULL);
  if (loader != NULL &&
      gdk_pixbuf_loader_write(loader, CODEINOVEN_ICON_PNG, CODEINOVEN_ICON_PNG_SIZE, NULL) &&
      gdk_pixbuf_loader_close(loader, NULL)) {
    GdkPixbuf *source = gdk_pixbuf_loader_get_pixbuf(loader);
    if (source != NULL) icon_pixbuf = gdk_pixbuf_scale_simple(source, 200, 200, GDK_INTERP_BILINEAR);
  }
  if (loader != NULL) g_object_unref(loader);
  gtk_widget_queue_draw(drawing_area);
  while (gtk_events_pending()) gtk_main_iteration();
  if (display != NULL) gdk_display_flush(display);

  if (create_handoff_socket() != 0) return 70;
  const size_t endpoint_size = strlen(handoff_path) + 1;
  if (write(endpoint_pipe, handoff_path, endpoint_size) != (ssize_t)endpoint_size) return 71;
  close(endpoint_pipe);
  pthread_t handoff_thread;
  pthread_create(&handoff_thread, NULL, wait_for_handoff, NULL);
  pthread_detach(handoff_thread);
  g_timeout_add_seconds(15, finish_helper, NULL);
  gtk_main();
  if (icon_pixbuf != NULL) g_object_unref(icon_pixbuf);
  return 0;
}

int main(int argc, char **argv) {
  char *child_path = electron_path();
  if (child_path == NULL) return 72;
  int ready_pipe[2] = {-1, -1};
  if (pipe(ready_pipe) != 0) return 73;
  pid_t helper_pid = fork();
  if (helper_pid == 0) {
    close(ready_pipe[0]);
    const int helper_result = run_helper(argc, argv, ready_pipe[1]);
    _exit(helper_result);
  }
  close(ready_pipe[1]);

  char endpoint[sizeof(handoff_path)] = {0};
  if (helper_pid > 0) {
    struct pollfd descriptor = {.fd = ready_pipe[0], .events = POLLIN, .revents = 0};
    if (poll(&descriptor, 1, 2500) > 0) {
      const ssize_t count = read(ready_pipe[0], endpoint, sizeof(endpoint) - 1);
      if (count > 0) endpoint[count] = '\0';
    }
  }
  close(ready_pipe[0]);
  if (endpoint[0] != '\0') {
    setenv("CODEINOVEN_NATIVE_SPLASH_ENDPOINT", endpoint, 1);
  } else if (helper_pid > 0) {
    kill(helper_pid, SIGTERM);
  }

  char **child_argv = calloc((size_t)argc + 1, sizeof(char *));
  if (child_argv == NULL) return 74;
  child_argv[0] = child_path;
  for (int index = 1; index < argc; index += 1) child_argv[index] = argv[index];
  execv(child_path, child_argv);
  if (helper_pid > 0) kill(helper_pid, SIGTERM);
  free(child_argv);
  free(child_path);
  return 75;
}
