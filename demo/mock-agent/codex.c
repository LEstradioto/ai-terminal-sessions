#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;

static void stop(int signal_number) {
  (void) signal_number;
  running = 0;
}

int main(int argc, char **argv) {
  const char *mode = "working";
  for (int index = 1; index + 1 < argc; index += 1) {
    if (strcmp(argv[index], "--mode") == 0) mode = argv[index + 1];
  }
  if (argc > 2 && strstr(argv[2], "22222222-") == argv[2]) mode = "ready";
  if (argc > 2 && strstr(argv[2], "33333333-") == argv[2]) mode = "permission";
  if (argc > 2 && strstr(argv[2], "44444444-") == argv[2]) mode = "ci";

  signal(SIGINT, stop);
  signal(SIGTERM, stop);
  setvbuf(stdout, NULL, _IOLBF, 0);

  if (strcmp(mode, "ready") == 0) {
    printf("\033[1;32m✓ Complete\033[0m  Generated responsive favicon assets\n");
    printf("\033[2mWaiting for your next message…\033[0m\n");
  } else if (strcmp(mode, "permission") == 0) {
    printf("\033[1;33mPermission required\033[0m\n");
    printf("Run database migration in the demo environment? \033[36m[y/N]\033[0m\n");
  } else if (strcmp(mode, "ci") == 0) {
    printf("\033[1;36mCI run #41\033[0m  main → preview\n");
  } else {
    printf("\033[1;36mCodex\033[0m  Building video ad variants\n");
  }

  int tick = 0;
  while (running) {
    if (strcmp(mode, "working") == 0) {
      const char *steps[] = {"Inspecting layout", "Rendering preview", "Checking breakpoints", "Polishing motion"};
      printf("\033[34m○\033[0m %-22s \033[2m%02ds\033[0m\n", steps[tick % 4], tick + 1);
    } else if (strcmp(mode, "ci") == 0) {
      printf("\033[32m✓ tests\033[0m  \033[2m50 passed\033[0m   \033[33m● deploy\033[0m  artifact %02d\n", tick + 1);
    }
    tick += 1;
    sleep(2);
  }
  return 0;
}
