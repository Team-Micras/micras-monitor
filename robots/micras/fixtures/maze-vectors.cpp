// Prints the maze records of `maze-vectors.ts` with the firmware's own TMaze::serialize.
//
// From a checkout of MicrasFirmware (feature/link-protocol-v2, 8ae3bbd):
//   g++ -std=c++23 -Imicras_core/include -Imicras_nav/include maze-vectors.cpp \
//       micras_nav/src/grid_pose.cpp -o maze-vectors && ./maze-vectors
#include <array>
#include <cstdio>
#include <vector>
#include "micras/nav/maze.hpp"

using namespace micras::nav;

static void print(const char* name, const std::vector<uint8_t>& bytes, bool last) {
    std::printf("  \"%s\": [", name);
    for (std::size_t i = 0; i < bytes.size(); i++) std::printf("%s%u", i ? ", " : "", bytes[i]);
    std::printf("]%s\n", last ? "" : ",");
}

int main() {
    constexpr std::array<GridPoint, 4> goal16{{{8, 8}, {7, 8}, {8, 7}, {7, 7}}};
    TMaze<16, 16> maze({.start = {.position = {0, 0}, .orientation = Side::UP}, .goal = goal16});
    std::printf("{\n");
    print("fresh16", maze.serialize(), false);
    maze.set_wall({.position = {0, 1}, .orientation = Side::RIGHT}, true);
    maze.set_wall({.position = {0, 1}, .orientation = Side::UP}, false);
    maze.set_wall({.position = {0, 2}, .orientation = Side::RIGHT}, false);
    maze.set_wall({.position = {1, 2}, .orientation = Side::DOWN}, true);
    maze.set_wall({.position = {1, 2}, .orientation = Side::LEFT}, false);
    maze.set_wall({.position = {5, 9}, .orientation = Side::LEFT}, true);
    maze.set_wall({.position = {15, 15}, .orientation = Side::DOWN}, false);
    print("explored16", maze.serialize(), false);
    constexpr std::array<GridPoint, 1> goal3{{{2, 1}}};
    TMaze<3, 3> small({.start = {.position = {0, 0}, .orientation = Side::RIGHT}, .goal = goal3});
    small.set_wall({.position = {1, 1}, .orientation = Side::UP}, true);
    small.set_wall({.position = {1, 0}, .orientation = Side::UP}, false);
    print("small3", small.serialize(), true);
    std::printf("}\n");
}
