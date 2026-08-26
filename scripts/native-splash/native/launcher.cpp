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
#include <cstring>
#include <string>
#include <vector>
#include "embedded_icon.h"

using Gdiplus::Bitmap;
using Gdiplus::Graphics;

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
    ShowWindow(window, SW_HIDE);
    return 0;
  }
  if (message == WM_ELECTRON_EXITED) {
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

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
  (void)previous;
  (void)command_line;
  (void)show_command;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  WNDCLASSW window_class = {};
  window_class.lpfnWndProc = window_procedure;
  window_class.hInstance = instance;
  window_class.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  window_class.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  window_class.lpszClassName = L"CodeInOvenStageZeroSplash";
  if (!RegisterClassW(&window_class)) return 60;

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
  if (placeholder_window == nullptr) return 61;
  ShowWindow(placeholder_window, SW_SHOW);
  UpdateWindow(placeholder_window);

  Gdiplus::GdiplusStartupInput startup_input;
  Gdiplus::GdiplusStartup(&gdiplus_token, &startup_input, nullptr);
  icon_bitmap = load_icon();
  InvalidateRect(placeholder_window, nullptr, FALSE);
  UpdateWindow(placeholder_window);

  unsigned char random_bytes[16] = {};
  if (BCryptGenRandom(nullptr, random_bytes, sizeof(random_bytes), BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
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
  if (handoff_pipe == INVALID_HANDLE_VALUE) return 63;

  int argument_count = 0;
  LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &argument_count);
  std::wstring child_path = electron_path();
  std::wstring child_command = quote_argument(child_path);
  for (int index = 1; index < argument_count; index += 1) {
    child_command.push_back(L' ');
    child_command.append(quote_argument(arguments[index]));
  }
  LocalFree(arguments);
  SetEnvironmentVariableW(L"CODEINOVEN_NATIVE_SPLASH_ENDPOINT", pipe_name);
  STARTUPINFOW startup = {};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process = {};
  std::vector<wchar_t> mutable_command(child_command.begin(), child_command.end());
  mutable_command.push_back(L'\0');
  const BOOL launched = CreateProcessW(
      child_path.c_str(),
      mutable_command.data(),
      nullptr,
      nullptr,
      FALSE,
      0,
      nullptr,
      nullptr,
      &startup,
      &process);
  SetEnvironmentVariableW(L"CODEINOVEN_NATIVE_SPLASH_ENDPOINT", nullptr);
  if (!launched) return 64;
  CloseHandle(process.hThread);
  electron_process = process.hProcess;

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
  CoUninitialize();
  return static_cast<int>(electron_exit_code);
}
