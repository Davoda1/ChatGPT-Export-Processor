/* Copyright (c) 2026 davoda1. MIT license. */
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

#ifndef PROCESSOR_EXECUTABLE
#define PROCESSOR_EXECUTABLE "/opt/chatgpt-export-processor/chatgpt-export-processor"
#endif

/* execv replaces this process: no shell, extra child, or signal forwarding. */
int main(int argc, char **argv) {
    (void)argc;
    argv[0] = (char *)PROCESSOR_EXECUTABLE;
    execv(PROCESSOR_EXECUTABLE, argv);
    const int error = errno;
    fprintf(stderr, "Unable to start ChatGPT Export Processor (system error %d).\n", error);
    return error == ENOENT ? 127 : 126;
}
