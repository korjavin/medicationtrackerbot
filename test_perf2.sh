#!/bin/bash
go test ./internal/store -bench BenchmarkAddIntakeReminder -run=^$ -benchtime=5s -count=3
