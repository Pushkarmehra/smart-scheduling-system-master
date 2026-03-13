#include <algorithm>
#include <fstream>
#include <iostream>
#include <map>
#include <random>
#include <set>
#include <string>
#include <vector>

using namespace std;

vector<string> days = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday"};
vector<string> slots = {"09:00-10:00", "10:00-11:00", "11:00-12:00", "13:00-14:00", "14:00-15:00"};
vector<string> batches = {"CSE-1", "CSE-2", "CSE-3", "CSE-4", "CSE-5", "CSE-6", "CSE-7", "CSE-8", "CSE-9", "CSE-10"};
vector<string> rooms = {"Room-101", "Room-102", "Room-103", "Room-104", "Room-105", "Room-106", "Room-107", "Room-108", "Room-109", "Room-110"};

map<string, string> subjectTeacher = {
    {"Data Structures", "Prof Verma"},
    {"Database Systems", "Prof Sharma"},
    {"Operating Systems", "Prof Kumar"},
    {"Computer Networks", "Prof Gupta"},
    {"Software Engineering", "Prof Singh"}
};

set<string> isBusy;
map<string, int> teacherDailyCount;

bool checkAvailability(const string& day, int slotIndex, const string& slot, const string& batch, const string& teacher, const string& room) {
    if (isBusy.count(day + "|" + slot + "|B:" + batch)) return false;
    if (isBusy.count(day + "|" + slot + "|T:" + teacher)) return false;
    if (isBusy.count(day + "|" + slot + "|R:" + room)) return false;

    string dayTeacher = day + "|" + teacher;

    if (teacherDailyCount[dayTeacher] >= 4) return false;

    return true;
}

void markBusy(const string& day, int slotIndex, const string& slot, const string& batch, const string& teacher, const string& room) {
    isBusy.insert(day + "|" + slot + "|B:" + batch);
    isBusy.insert(day + "|" + slot + "|T:" + teacher);
    isBusy.insert(day + "|" + slot + "|R:" + room);

    string dayTeacher = day + "|" + teacher;
    teacherDailyCount[dayTeacher]++;
}

int main() {
    ofstream outFile("timetable_cleaned.json");
    if (!outFile.is_open()) {
        cerr << "Failed to open timetable_cleaned.json for writing." << endl;
        return 1;
    }

    random_device rd;
    mt19937 rng(rd());

    int idCounter = 1;
    bool firstEntry = true;
    int classesPerSubjectPerWeek = 2;

    outFile << "{\n  \"timetable\": [\n";

    for (const auto& batch : batches) {
        for (const auto& pair : subjectTeacher) {
            const string& subject = pair.first;
            const string& teacher = pair.second;
            int scheduled = 0;

            vector<string> dayOrder = days;
            shuffle(dayOrder.begin(), dayOrder.end(), rng);

            for (const string& day : dayOrder) {
                vector<int> slotOrder;
                for (int i = 0; i < static_cast<int>(slots.size()); ++i) {
                    slotOrder.push_back(i);
                }
                shuffle(slotOrder.begin(), slotOrder.end(), rng);

                for (int slotIndex : slotOrder) {
                    if (scheduled >= classesPerSubjectPerWeek) break;

                    const string& slot = slots[slotIndex];
                    vector<string> roomOrder = rooms;
                    shuffle(roomOrder.begin(), roomOrder.end(), rng);

                    bool placed = false;
                    for (const string& room : roomOrder) {
                        if (!checkAvailability(day, slotIndex, slot, batch, teacher, room)) {
                            continue;
                        }

                        markBusy(day, slotIndex, slot, batch, teacher, room);

                        if (!firstEntry) outFile << ",\n";
                        firstEntry = false;

                        outFile << "    {\n";
                        outFile << "      \"id\": \"" << idCounter++ << "\",\n";
                        outFile << "      \"day\": \"" << day << "\",\n";
                        outFile << "      \"timeSlot\": \"" << slot << "\",\n";
                        outFile << "      \"room\": \"" << room << "\",\n";
                        outFile << "      \"course\": \"" << subject << "\",\n";
                        outFile << "      \"faculty\": \"" << teacher << "\",\n";
                        outFile << "      \"batch\": \"" << batch << "\"\n";
                        outFile << "    }";

                        scheduled++;
                        placed = true;
                        break;
                    }

                    if (scheduled >= classesPerSubjectPerWeek) break;
                    if (!placed) continue;
                }

                if (scheduled >= classesPerSubjectPerWeek) break;
            }
        }
    }

    outFile << "\n  ]\n}\n";
    outFile.close();

    cout << "Generated timetable with 10 batches, 10 rooms, 5 teachers, and workload balancing." << endl;
    return 0;
}
