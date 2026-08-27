#define UNICODE
#define _UNICODE
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <bcrypt.h>
#include <gdiplus.h>
#include <objidl.h>
#include <shellapi.h>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "embedded_icon.h"

using Gdiplus::Bitmap;
using Gdiplus::Graphics;

static HANDLE log_handle = INVALID_HANDLE_VALUE;

static void log_close() {
  if (log_handle == INVALID_HANDLE_VALUE) return;
  FlushFileBuffers(log_handle);
  CloseHandle(log_handle);
  log_handle = INVALID_HANDLE_VALUE;
}

static bool log_open() {
  std::vector<wchar_t> module_path(32768);
  DWORD length = GetModuleFileNameW(nullptr, module_path.data(), static_cast<DWORD>(module_path.size()));
  std::wstring log_path(module_path.data(), length);
  const size_t dot = log_path.find_last_of(L'.');
  if (dot == std::wstring::npos) {
    log_path += L".startup.log";
  } else {
    log_path = log_path.substr(0, dot) + L".startup.log";
  }
  SECURITY_ATTRIBUTES security = { sizeof(security), nullptr, TRUE };
  log_handle = CreateFileW(
      log_path.c_str(),
      FILE_APPEND_DATA,
      FILE_SHARE_READ,
      &security,
      OPEN_ALWAYS,
      FILE_ATTRIBUTE_NORMAL,
      nullptr);
  return log_handle != INVALID_HANDLE_VALUE;
}

static void log_write_narrow(const char *data, size_t length = 0) {
  if (log_handle == INVALID_HANDLE_VALUE) return;
  if (length == 0) length = strlen(data);
  DWORD written = 0;
  WriteFile(log_handle, data, static_cast<DWORD>(length), &written, nullptr);
}

static void log_write_wide(const std::wstring &text) {
  if (log_handle == INVALID_HANDLE_VALUE || text.empty()) return;
  const int size = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return;
  std::vector<char> buffer(size);
  WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), buffer.data(), size, nullptr, nullptr);
  DWORD written = 0;
  WriteFile(log_handle, buffer.data(), static_cast<DWORD>(buffer.size()), &written, nullptr);
}

static void log_timestamp() {
  SYSTEMTIME time = {};
  GetLocalTime(&time);
  char buffer[64] = {};
  snprintf(
      buffer,
      sizeof(buffer),
      "%04d-%02d-%02d %02d:%02d:%02d.%03d ",
      time.wYear,
      time.wMonth,
      time.wDay,
      time.wHour,
      time.wMinute,
      time.wSecond,
      time.wMilliseconds);
  log_write_narrow(buffer);
}

static void log_line(const char *text) {
  log_timestamp();
  log_write_narrow(text);
  log_write_narrow("\r\n", 2);
}

static void log_line(const std::wstring &text) {
  log_timestamp();
  log_write_wide(text);
  log_write_narrow("\r\n", 2);
}

static void log_line_format(const char *format, ...) {
  char buffer[8192] = {};
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(buffer, sizeof(buffer), format, arguments);
  va_end(arguments);
  log_line(buffer);
}

static void draw_centered_text(Graphics &graphics, const wchar_t *text, float baseline,
                               float font_size, BYTE alpha, float width) {
  Gdiplus::FontFamily family(L"Segoe UI");
  Gdiplus::Font font(&family, font_size, Gdiplus::FontStyleRegular, Gdiplus::UnitPixel);
  Gdiplus::SolidBrush brush(Gdiplus::Color(alpha, 247, 246, 242));
  Gdiplus::StringFormat format;
  format.SetAlignment(Gdiplus::StringAlignmentCenter);
  graphics.DrawString(text, -1, &font, Gdiplus::RectF(0.0f, baseline, width, font_size + 3.0f),
                      &format, &brush);
}

static const UINT WM_SPLASH_READY = WM_APP + 1;
static const UINT WM_ELECTRON_EXITED = WM_APP + 2;
static HWND placeholder_window = nullptr;
static HANDLE handoff_pipe = INVALID_HANDLE_VALUE;
static HANDLE electron_process = nullptr;
static DWORD electron_exit_code = 1;
static Bitmap *icon_bitmap = nullptr;
static ULONG_PTR gdiplus_token = 0;

static std::wstring quote_argument(const std::wstring &argument) {
  if (argument.find_first_of(L" \t\"") == std::wstring::npos) return argument;
  std::wstring result = L"\"";
  size_t backslashes = 0;
  for (wchar_t character : argument) {
    if (character == L'\\') {
      backslashes += 1;
    } else if (character == L'\"') {
      result.append(backslashes * 2 + 1, L'\\');
      result.push_back(L'\"');
      backslashes = 0;
    } else {
      result.append(backslashes, L'\\');
      backslashes = 0;
      result.push_back(character);
    }
  }
  result.append(backslashes * 2, L'\\');
  result.push_back(L'\"');
  return result;
}

static std::wstring electron_path() {
  std::vector<wchar_t> path(32768);
  DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  std::wstring executable(path.data(), length);
  const size_t separator = executable.find_last_of(L"\\/");
  return executable.substr(0, separator + 1) + L"CodeInOven-electron.exe";
}

static Bitmap *load_icon() {
  HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, CODEINOVEN_ICON_PNG_SIZE);
  if (memory == nullptr) return nullptr;
  void *bytes = GlobalLock(memory);
  CopyMemory(bytes, CODEINOVEN_ICON_PNG, CODEINOVEN_ICON_PNG_SIZE);
  GlobalUnlock(memory);
  IStream *stream = nullptr;
  if (CreateStreamOnHGlobal(memory, TRUE, &stream) != S_OK) {
    GlobalFree(memory);
    return nullptr;
  }
  Bitmap *decoded = Bitmap::FromStream(stream);
  Bitmap *bitmap = nullptr;
  if (decoded != nullptr && decoded->GetLastStatus() == Gdiplus::Ok) {
    bitmap = decoded->Clone(
        0,
        0,
        static_cast<INT>(decoded->GetWidth()),
        static_cast<INT>(decoded->GetHeight()),
        PixelFormat32bppPARGB);
  }
  delete decoded;
  stream->Release();
  if (bitmap == nullptr || bitmap->GetLastStatus() != Gdiplus::Ok) {
    delete bitmap;
    return nullptr;
  }
  return bitmap;
}

static LRESULT CALLBACK window_procedure(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
  (void)wparam;
  (void)lparam;
  if (message == WM_PAINT) {
    PAINTSTRUCT paint = {};
    HDC device = BeginPaint(window, &paint);
    RECT client = {};
    GetClientRect(window, &client);
    HBRUSH black = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    FillRect(device, &client, black);
    Graphics graphics(device);
    if (icon_bitmap != nullptr) {
      graphics.SetInterpolationMode(Gdiplus::InterpolationModeHighQualityBicubic);
      graphics.DrawImage(icon_bitmap, (client.right - 200) / 2, (client.bottom - 200) / 2, 200, 200);
    }
    static wchar_t version_by_line[256];
    swprintf_s(version_by_line, L"%ls - By", CODEINOVEN_VERSION_WIDE);
    draw_centered_text(graphics, version_by_line, 275.0f, 11.0f, 184, client.right);
    draw_centered_text(graphics, CODEINOVEN_COMPANY_WIDE, 291.0f, 11.0f, 184, client.right);
    EndPaint(window, &paint);
    return 0;
  }
  if (message == WM_SPLASH_READY) {
    log_line("Received splash ready signal; hiding placeholder window");
    ShowWindow(window, SW_HIDE);
    return 0;
  }
  if (message == WM_ELECTRON_EXITED) {
    log_line_format("Electron process exited with code %lu", electron_exit_code);
    ShowWindow(window, SW_HIDE);
    PostQuitMessage(static_cast<int>(electron_exit_code));
    return 0;
  }
  if (message == WM_CLOSE) return 0;
  return DefWindowProcW(window, message, wparam, lparam);
}

static DWORD WINAPI wait_for_handoff(void *) {
  const BOOL connected = ConnectNamedPipe(handoff_pipe, nullptr)
                             ? TRUE
                             : GetLastError() == ERROR_PIPE_CONNECTED;
  char message[16] = {};
  DWORD count = 0;
  if (connected && ReadFile(handoff_pipe, message, sizeof(message) - 1, &count, nullptr) &&
      count >= 5 && std::memcmp(message, "ready", 5) == 0) {
    PostMessageW(placeholder_window, WM_SPLASH_READY, 0, 0);
  }
  DisconnectNamedPipe(handoff_pipe);
  CloseHandle(handoff_pipe);
  handoff_pipe = INVALID_HANDLE_VALUE;
  return 0;
}

static DWORD WINAPI wait_for_electron(void *) {
  WaitForSingleObject(electron_process, INFINITE);
  GetExitCodeProcess(electron_process, &electron_exit_code);
  if (handoff_pipe != INVALID_HANDLE_VALUE) CancelIoEx(handoff_pipe, nullptr);
  PostMessageW(placeholder_window, WM_ELECTRON_EXITED, 0, 0);
  return 0;
}

static BOOL launch_electron(const std::wstring &child_path, const std::wstring &child_command, HANDLE *out_process) {
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  HANDLE stdin_handle = GetStdHandle(STD_INPUT_HANDLE);
  if (stdin_handle == INVALID_HANDLE_VALUE) stdin_handle = nullptr;
  const HANDLE output_handle = (log_handle != INVALID_HANDLE_VALUE) ? log_handle : nullptr;
  startup.hStdInput = stdin_handle;
  startup.hStdOutput = output_handle;
  startup.hStdError = output_handle;
  startup.dwFlags = STARTF_USESTDHANDLES;

  std::vector<wchar_t> mutable_command(child_command.begin(), child_command.end());
  mutable_command.push_back(L'\0');

  log_line_format("child_path=%ls", child_path.c_str());
  log_line_format("child_command=%ls", child_command.c_str());

  PROCESS_INFORMATION process = {};
  const BOOL launched = CreateProcessW(
      child_path.c_str(),
      mutable_command.data(),
      nullptr,
      nullptr,
      TRUE,
      0,
      nullptr,
      nullptr,
      &startup,
      &process);
  if (launched) {
    CloseHandle(process.hThread);
    *out_process = process.hProcess;
    log_line_format("CreateProcessW succeeded, child_pid=%lu", process.dwProcessId);
  } else {
    log_line_format("CreateProcessW failed, error=%lu", GetLastError());
  }
  return launched;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
  (void)previous;
  (void)command_line;
  (void)show_command;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  log_open();
  log_line("Launcher started");

  int argument_count = 0;
  LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  const std::wstring child_path = electron_path();
  std::wstring child_command = quote_argument(child_path);
  for (int index = 1; index < argument_count; index += 1) {
    child_command.push_back(L' ');
    child_command.append(quote_argument(arguments[index]));
  }
  LocalFree(arguments);

  wchar_t bypass[2] = {};
  const DWORD bypass_length = GetEnvironmentVariableW(L"CODEINOVEN_DISABLE_NATIVE_SPLASH", bypass, 2);
  if (bypass_length > 0 && bypass[0] == L'1') {
    log_line("CODEINOVEN_DISABLE_NATIVE_SPLASH=1; bypassing native splash");
    HANDLE bypass_process = nullptr;
    if (!launch_electron(child_path, child_command, &bypass_process)) {
      log_close();
      return 64;
    }
    WaitForSingleObject(bypass_process, INFINITE);
    GetExitCodeProcess(bypass_process, &electron_exit_code);
    log_line_format("Electron exited with code %lu", electron_exit_code);
    CloseHandle(bypass_process);
    log_close();
    CoUninitialize();
    return static_cast<int>(electron_exit_code);
  }

  WNDCLASSW window_class = {};
  window_class.lpfnWndProc = window_procedure;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  window_class.lpszClassName = L"CodeInOvenStageZeroSplash";
  if (!RegisterClassW(&window_class)) {
    log_line_format("RegisterClassW failed, error=%lu", GetLastError());
    log_close();
    return 60;
  }

  const int width = 420;
  const int height = 320;
  const int x = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
  const int y = (GetSystemMetrics(SM_CYSCREEN) - height) / 2;
  placeholder_window = CreateWindowExW(
      WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
      window_class.lpszClassName,
      L"CodeInOven",
      WS_POPUP,
      x,
      y,
      width,
      height,
      nullptr,
      nullptr,
      instance,
      nullptr);
  if (placeholder_window == nullptr) {
    log_line_format("CreateWindowExW failed, error=%lu", GetLastError());
    log_close();
    return 61;
  }
  ShowWindow(placeholder_window, SW_SHOW);
  UpdateWindow(placeholder_window);

  Gdiplus::GdiplusStartupInput startup_input;
  Gdiplus::GdiplusStartup(&gdiplus_token, &startup_input, nullptr);
  icon_bitmap = load_icon();
  InvalidateRect(placeholder_window, nullptr, FALSE);
  UpdateWindow(placeholder_window);

  unsigned char random_bytes[16] = {};
  if (BCryptGenRandom(nullptr, random_bytes, sizeof(random_bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    log_line("BCryptGenRandom failed");
    log_close();
    return 62;
  }
  wchar_t pipe_name[160] = {};
  wchar_t random_hex[33] = {};
  for (size_t index = 0; index < sizeof(random_bytes); index += 1) {
    swprintf_s(random_hex + index * 2, 3, L"%02x", random_bytes[index]);
  }
  swprintf_s(pipe_name, L"\\\\.\\pipe\\codeinoven-splash-%lu-%ls", GetCurrentProcessId(), random_hex);
  handoff_pipe = CreateNamedPipeW(
      pipe_name,
      PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      1,
      32,
      32,
      0,
      nullptr);
  if (handoff_pipe == INVALID_HANDLE_VALUE) {
    log_line_format("CreateNamedPipeW failed, error=%lu", GetLastError());
    log_close();
    return 63;
  }
  log_line_format("created named pipe %ls", pipe_name);

  SetEnvironmentVariableW(L"CODEINOVEN_NATIVE_SPLASH_ENDPOINT", pipe_name);
  if (!launch_electron(child_path, child_command, &electron_process)) {
    SetEnvironmentVariableW(L"CODEINOVEN_NATIVE_SPLASH_ENDPOINT", nullptr);
    log_close();
    return 64;
  }
  SetEnvironmentVariableW(L"CODEINOVEN_NATIVE_SPLASH_ENDPOINT", nullptr);

  HANDLE handoff_thread = CreateThread(nullptr, 0, wait_for_handoff, nullptr, 0, nullptr);
  HANDLE electron_thread = CreateThread(nullptr, 0, wait_for_electron, nullptr, 0, nullptr);
  if (handoff_thread != nullptr) CloseHandle(handoff_thread);
  if (electron_thread != nullptr) CloseHandle(electron_thread);

  MSG message = {};
  while (GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }
  CloseHandle(electron_process);
  delete icon_bitmap;
  Gdiplus::GdiplusShutdown(gdiplus_token);
  log_close();
  CoUninitialize();
  return static_cast<int>(electron_exit_code);
}
