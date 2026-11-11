#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

static int showError(const wchar_t *message, DWORD code) {
    fwprintf(stderr, L"\nShark: %ls (%lu). Please re-extract the complete package and try again.\n",
             message, (unsigned long)code);
    DWORD mode;
    if (GetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), &mode)) {
        fputws(L"Press Enter to close.\n", stderr);
        getchar();
    }
    return 1;
}

static BOOL WINAPI keepWaiting(DWORD event) {
    // Node receives the same console signal and can close its local service.
    return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int main(void) {
    static wchar_t directory[32768], executable[32768], commandLine[32767];
    DWORD length = GetModuleFileNameW(NULL, directory, ARRAYSIZE(directory));
    if (!length || length >= ARRAYSIZE(directory)) {
        return showError(L"Cannot locate the Shark package", GetLastError());
    }
    wchar_t *separator = wcsrchr(directory, L'\\');
    if (!separator) return showError(L"Cannot locate the Shark package", ERROR_INVALID_NAME);
    separator[1] = L'\0';

    if (swprintf(executable, ARRAYSIZE(executable), L"%lsapp\\bin\\node.exe", directory) < 0 ||
        swprintf(commandLine, ARRAYSIZE(commandLine), L"\"%ls\" \"%lsapp\\desktop\\main.mjs\" --browser",
                 executable, directory) < 0) {
        return showError(L"The package path is too long", ERROR_FILENAME_EXCED_RANGE);
    }

    // Keep the portable startup environment consistent with the CMD entry.
    const wchar_t *const overrides[] = {
        L"NODE_OPTIONS", L"NODE_PATH", L"NODE_EXTRA_CA_CERTS", L"CLIP_FETCHER_PORT",
        L"CLIP_FETCHER_OUTPUT_DIR", L"CLIP_FETCHER_DATA_DIR", L"CLIP_FETCHER_PARENT_PID",
    };
    for (size_t i = 0; i < ARRAYSIZE(overrides); ++i) {
        if (!SetEnvironmentVariableW(overrides[i], NULL)) {
            DWORD code = GetLastError();
            if (code != ERROR_ENVVAR_NOT_FOUND) return showError(L"Cannot prepare the startup environment", code);
        }
    }
    SetConsoleCP(CP_UTF8);
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleTitleW(L"Shark");
    SetConsoleCtrlHandler(keepWaiting, TRUE);

    STARTUPINFOW startup = {0};
    PROCESS_INFORMATION process = {0};
    startup.cb = sizeof(startup);
    if (!CreateProcessW(executable, commandLine, NULL, NULL, FALSE, 0, NULL, NULL, &startup, &process)) {
        return showError(L"Cannot start the local service", GetLastError());
    }
    CloseHandle(process.hThread);
    DWORD exitCode = ERROR_PROCESS_ABORTED;
    if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0 ||
        !GetExitCodeProcess(process.hProcess, &exitCode)) {
        DWORD code = GetLastError();
        CloseHandle(process.hProcess);
        return showError(L"Cannot read the local service exit status", code);
    }
    CloseHandle(process.hProcess);
    if (exitCode && exitCode != 130 && exitCode != 0xC000013A) {
        showError(L"The local service stopped", exitCode);
    }
    ExitProcess(exitCode);
}
