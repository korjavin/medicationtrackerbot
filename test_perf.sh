#!/bin/bash
go test ./internal/store -bench BenchmarkAddIntakeReminder -run=^$ -count=5
